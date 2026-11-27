import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { recordAudit } from '../audit/record.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { isValidWorkspaceId, type WorkspaceMember, type WorkspaceRole, type WorkspaceStore } from '../workspace/workspace.js';

/**
 * S1-9 — invitation links. A person who may manage the workspace makes a link for a role; whoever opens it signed in joins with
 * that role, once.
 *
 * What this does and does not promise (stated here because "invite" invites assumptions):
 *  - A link grants at most the role it was made for, and never `admin` (an admin is added deliberately, by identity, through
 *    the members route). Accepting never changes the role of someone who already has access.
 *  - The link is a secret shown ONCE, when it is made. Only a SHA-256 of its secret is stored, inside the workspace's own state,
 *    so no other workspace can read it. It expires after 7 days and works once.
 *  - Every way a link can fail (never existed, wrong workspace, expired, used, taken back) answers the same 404, so a link
 *    cannot be probed. A link to a workspace the caller already belongs to answers 409 and is not used up.
 *  - There is no email: the API stores and sends no address. Delivery is the inviter handing over the link.
 *  - Audit records the invitation id and the role. Never the link, the secret or an address.
 *  - Single use is enforced inside one API process (the same single-process assumption as the scheduler).
 */

const ROLES_BY_LINK: readonly WorkspaceRole[] = ['publisher', 'reviewer', 'viewer'];
const LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const KEY = (id: string) => `invitations/${id}.json`;

interface InvitationRecord {
  readonly invitationId: string;
  readonly role: WorkspaceRole;
  readonly secretSha256: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly usedAt?: string;
  readonly usedBy?: string;
}

type InvitationState = 'pending' | 'used' | 'revoked' | 'expired';

function stateOf(r: InvitationRecord, now: number): InvitationState {
  if (r.usedAt !== undefined) return 'used';
  if (r.revokedAt !== undefined) return 'revoked';
  return Date.parse(r.expiresAt) <= now ? 'expired' : 'pending';
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

const wire = (r: InvitationRecord, now: number) => ({
  invitationId: r.invitationId,
  role: r.role,
  state: stateOf(r, now),
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  ...(r.usedAt !== undefined ? { usedAt: r.usedAt } : {}),
});

export function registerInvitationRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  // One accept at a time per workspace, so two people opening the same link cannot both get in.
  const chains = new Map<string, Promise<unknown>>();
  const exclusive = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.get(workspaceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    chains.set(
      workspaceId,
      next.catch(() => undefined),
    );
    return next;
  };

  async function readAll(workspace: Parameters<typeof workspaceStateStore>[0]): Promise<InvitationRecord[]> {
    const store = workspaceStateStore(workspace, dataConfig);
    const keys = await store.list('invitations/');
    if (!keys.ok) return [];
    const out: InvitationRecord[] = [];
    for (const k of keys.value) {
      const raw = await store.get(k);
      if (!raw.ok) continue;
      try {
        out.push(JSON.parse(new TextDecoder().decode(raw.value)) as InvitationRecord);
      } catch {
        /* an unreadable file is not an invitation */
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function save(workspace: Parameters<typeof workspaceStateStore>[0], r: InvitationRecord): Promise<void> {
    const put = await workspaceStateStore(workspace, dataConfig).put(KEY(r.invitationId), JSON.stringify(r), {
      contentType: 'application/json',
    });
    if (!put.ok) throw put.error;
  }

  async function create(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'invite someone' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'invite someone');
    if ((workspace.kind ?? 'team') === 'personal')
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'a personal workspace is single-identity and cannot have members');
    const b = await req.json<{ role?: unknown }>();
    if (!b.ok) throw b.error;
    const role = b.value?.role;
    if (typeof role !== 'string' || !(ROLES_BY_LINK as readonly string[]).includes(role))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `"role" must be one of: ${ROLES_BY_LINK.join(', ')}. An admin is added by identity.`);
    const secret = randomBytes(32).toString('base64url');
    const now = Date.now();
    const record: InvitationRecord = {
      invitationId: `inv_${randomBytes(6).toString('hex')}`,
      role: role as WorkspaceRole,
      secretSha256: sha256(secret),
      createdBy: callerIdentityId(req),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + LIFETIME_MS).toISOString(),
    };
    await save(workspace, record);
    await recordAudit(req, workspace, dataConfig, {
      event: 'invitation.created',
      result: 'succeeded',
      target: { kind: 'invitation', id: record.invitationId },
      detail: { role: record.role },
    });
    // The only time the link's secret is ever returned.
    return json(201, { invitation: wire(record, now), token: `${workspace.workspaceId}.${secret}` });
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'see invitations' });
    const now = Date.now();
    return json(200, { invitations: (await readAll(workspace)).map((r) => wire(r, now)) });
  }

  async function revoke(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'take back an invitation' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'take back an invitation');
    const id = req.params['invitationId'] ?? '';
    return exclusive(workspace.workspaceId, async () => {
      const r = (await readAll(workspace)).find((x) => x.invitationId === id);
      if (r === undefined) throw new NotFoundError(`invitation "${id}"`);
      if (stateOf(r, Date.now()) !== 'pending') throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this invitation is no longer open');
      const next = { ...r, revokedAt: new Date().toISOString() };
      await save(workspace, next);
      await recordAudit(req, workspace, dataConfig, {
        event: 'invitation.revoked',
        result: 'succeeded',
        target: { kind: 'invitation', id },
        detail: { role: r.role },
      });
      return json(200, { invitation: wire(next, Date.now()) });
    });
  }

  async function accept(req: ApiRequest): Promise<ApiResponse> {
    const caller = callerIdentityId(req);
    const b = await req.json<{ token?: unknown }>();
    if (!b.ok) throw b.error;
    const token = b.value?.token;
    const refused = new NotFoundError('invitation');
    if (typeof token !== 'string' || token.length > 200) throw refused;
    const dot = token.indexOf('.');
    const workspaceId = dot > 0 ? token.slice(0, dot) : '';
    const secret = dot > 0 ? token.slice(dot + 1) : '';
    if (!isValidWorkspaceId(workspaceId) || secret.length < 20) throw refused;
    const found = await workspaceStore.get(workspaceId);
    if (!found.ok) throw refused;
    return exclusive(workspaceId, async () => {
      // Read again inside the lock: the workspace and the invitation as they are now.
      const ws = await workspaceStore.get(workspaceId);
      if (!ws.ok) throw refused;
      const hash = sha256(secret);
      const r = (await readAll(ws.value)).find((x) => same(x.secretSha256, hash));
      if (r === undefined || stateOf(r, Date.now()) !== 'pending') throw refused;
      const already = ws.value.identityId === caller || (ws.value.members ?? []).some((m) => m.identityId === caller);
      if (already) throw new XoError(ErrorCode.ALREADY_EXISTS, 'you already have access to this workspace');
      const member: WorkspaceMember = { identityId: caller, role: r.role, addedBy: r.createdBy, addedAt: new Date().toISOString() };
      // Use the link up first: if adding the person then fails, the link is spent, never reusable.
      await save(ws.value, { ...r, usedAt: new Date().toISOString(), usedBy: caller });
      const updated = await workspaceStore.update(workspaceId, { members: [...(ws.value.members ?? []), member] });
      if (!updated.ok) throw updated.error;
      await recordAudit(req, updated.value, dataConfig, {
        event: 'invitation.accepted',
        result: 'succeeded',
        target: { kind: 'invitation', id: r.invitationId },
        detail: { role: r.role },
      });
      return json(200, { workspaceId, role: r.role });
    });
  }

  router.post('/workspaces/:workspaceId/invitations', guarded(create));
  router.get('/workspaces/:workspaceId/invitations', guarded(list));
  router.delete('/workspaces/:workspaceId/invitations/:invitationId', guarded(revoke));
  router.post('/invitations/accept', guarded(accept));
}
