import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  callerRole,
  requireOwnedWorkspace,
  requirePermission,
  workspaceAuditStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { isWorkspaceRole, WORKSPACE_ROLES, type WorkspaceMember, type WorkspaceRecord, type WorkspaceRole, type WorkspaceStore } from '../workspace/workspace.js';
import { permissionsOf } from '../workspace/permissions.js';
import { REGIONS } from '../workspace/regions.js';
import { FsAuditLog } from '../audit/fs-audit-log.js';
import { isAuditEventType, isAuditResult } from '../audit/audit-entry.js';
import { recordAudit } from '../audit/record.js';
import { declaredRetentionDays } from '../audit/retention.js';
import { buildAuditExport, auditExportToCsv } from '../audit/export.js';

/**
 * Workspace administration surface: the region vocabulary, members + roles, and the audit log (list / verify /
 * export). Every route resolves the workspace through `requireOwnedWorkspace` first (404 for non-members), then
 * checks a workspace permission (403 + an `access.denied` audit entry for members who lack it).
 */

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

function optionalString(body: Record<string, unknown>, field: string, max: number): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${field}", if present, must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

interface MemberWire {
  readonly identityId: string;
  readonly role: WorkspaceRole;
  readonly isOwner: boolean;
  readonly displayName?: string;
  readonly email?: string;
  readonly addedAt?: string;
}

function membersWire(workspace: WorkspaceRecord): readonly MemberWire[] {
  return [
    { identityId: workspace.identityId, role: 'admin', isOwner: true, addedAt: workspace.createdAt },
    ...(workspace.members ?? []).map(
      (m): MemberWire => ({
        identityId: m.identityId,
        role: m.role,
        isOwner: false,
        ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
        ...(m.email !== undefined ? { email: m.email } : {}),
        addedAt: m.addedAt,
      }),
    ),
  ];
}

function roleCounts(members: readonly MemberWire[]): Record<WorkspaceRole, number> {
  const counts: Record<WorkspaceRole, number> = { admin: 0, publisher: 0, reviewer: 0, viewer: 0 };
  for (const m of members) counts[m.role] += 1;
  return counts;
}

export function registerWorkspaceAdminRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig): void {
  // ---- regions (declaration vocabulary)
  router.get('/regions', guarded(async () => json(200, { regions: REGIONS })));

  // ---- members + roles
  async function listMembers(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const members = membersWire(workspace);
    const role = callerRole(req, workspace);
    return json(200, {
      members,
      total: members.length,
      roleCounts: roleCounts(members),
      callerRole: role,
      callerPermissions: permissionsOf(role),
      roles: WORKSPACE_ROLES.map((r) => ({ role: r, permissions: permissionsOf(r) })),
    });
  }

  async function addMember(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'add member' });
    const bodyResult = await req.json();
    if (!bodyResult.ok) throw bodyResult.error;
    const body = objectBody(bodyResult.value);

    const identityId = body['identityId'];
    if (typeof identityId !== 'string' || !MEMBER_ID_PATTERN.test(identityId)) {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"identityId" must be 1-128 characters: letters, digits, and . _ : @ -');
    }
    const role = body['role'];
    if (!isWorkspaceRole(role)) throw new XoError(ErrorCode.INVALID_ARGUMENT, `"role" must be one of: ${WORKSPACE_ROLES.join(', ')}`);
    const displayName = optionalString(body, 'displayName', 120);
    const email = optionalString(body, 'email', 254);

    if ((workspace.kind ?? 'team') === 'personal') {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'a personal workspace is single-identity and cannot have members');
    }
    if (identityId === workspace.identityId || (workspace.members ?? []).some((m) => m.identityId === identityId)) {
      throw new XoError(ErrorCode.ALREADY_EXISTS, `identity "${identityId}" already has access to this workspace`);
    }
    const member: WorkspaceMember = {
      identityId,
      role,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(email !== undefined ? { email } : {}),
      addedBy: req.identity?.identityId ?? 'unknown',
      addedAt: new Date().toISOString(),
    };
    const updated = await workspaceStore.update(workspace.workspaceId, { members: [...(workspace.members ?? []), member] });
    if (!updated.ok) throw updated.error;
    await recordAudit(req, updated.value, dataConfig, {
      event: 'member.added',
      result: 'succeeded',
      target: { kind: 'member', id: identityId, ...(displayName !== undefined ? { label: displayName } : {}) },
      detail: { role },
    });
    return json(201, { member: membersWire(updated.value).find((m) => m.identityId === identityId) });
  }

  async function changeMemberRole(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'change member role' });
    const identityId = req.params['identityId'];
    if (identityId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing member id');
    if (identityId === workspace.identityId) {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'the workspace owner is always an admin and cannot be changed');
    }
    const existing = (workspace.members ?? []).find((m) => m.identityId === identityId);
    if (existing === undefined) throw new NotFoundError(`member "${identityId}"`);
    const bodyResult = await req.json();
    if (!bodyResult.ok) throw bodyResult.error;
    const body = objectBody(bodyResult.value);
    const role = body['role'];
    if (!isWorkspaceRole(role)) throw new XoError(ErrorCode.INVALID_ARGUMENT, `"role" must be one of: ${WORKSPACE_ROLES.join(', ')}`);
    const members = (workspace.members ?? []).map((m) => (m.identityId === identityId ? { ...m, role } : m));
    const updated = await workspaceStore.update(workspace.workspaceId, { members });
    if (!updated.ok) throw updated.error;
    await recordAudit(req, updated.value, dataConfig, {
      event: 'member.role_changed',
      result: 'succeeded',
      target: { kind: 'member', id: identityId, ...(existing.displayName !== undefined ? { label: existing.displayName } : {}) },
      detail: { from: existing.role, to: role },
    });
    return json(200, { member: membersWire(updated.value).find((m) => m.identityId === identityId) });
  }

  async function removeMember(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'remove member' });
    const identityId = req.params['identityId'];
    if (identityId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing member id');
    if (identityId === workspace.identityId) {
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'the workspace owner cannot be removed');
    }
    const existing = (workspace.members ?? []).find((m) => m.identityId === identityId);
    if (existing === undefined) throw new NotFoundError(`member "${identityId}"`);
    const updated = await workspaceStore.update(workspace.workspaceId, { members: (workspace.members ?? []).filter((m) => m.identityId !== identityId) });
    if (!updated.ok) throw updated.error;
    await recordAudit(req, updated.value, dataConfig, {
      event: 'member.removed',
      result: 'succeeded',
      target: { kind: 'member', id: identityId, ...(existing.displayName !== undefined ? { label: existing.displayName } : {}) },
      detail: { role: existing.role },
    });
    return json(200, { removed: identityId });
  }

  router.get('/workspaces/:workspaceId/members', guarded(listMembers));
  router.post('/workspaces/:workspaceId/members', guarded(addMember));
  router.patch('/workspaces/:workspaceId/members/:identityId', guarded(changeMemberRole));
  router.delete('/workspaces/:workspaceId/members/:identityId', guarded(removeMember));

  // ---- audit log
  function auditLog(workspace: WorkspaceRecord): FsAuditLog {
    return new FsAuditLog(workspaceAuditStore(workspace, dataConfig), workspace.workspaceId);
  }

  async function listAudit(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'audit', dataConfig, { action: 'read audit log' });
    const q = req.query;
    const event = q.get('event');
    if (event !== null && !isAuditEventType(event)) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown audit event "${event}"`);
    const result = q.get('result');
    if (result !== null && !isAuditResult(result)) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown audit result "${result}"`);
    const limitRaw = q.get('limit');
    const limit = limitRaw === null ? undefined : Number(limitRaw);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"limit" must be a positive integer');
    const beforeRaw = q.get('before');
    const before = beforeRaw === null ? undefined : Number(beforeRaw);
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"before" must be a positive integer');
    for (const name of ['since', 'until']) {
      const v = q.get(name);
      if (v !== null && Number.isNaN(Date.parse(v))) throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${name}" must be an ISO-8601 timestamp`);
    }
    const page = await auditLog(workspace).list({
      ...(event !== null ? { event } : {}),
      ...(result !== null ? { result } : {}),
      ...(q.get('actor') !== null ? { actorIdentityId: q.get('actor') as string } : {}),
      ...(q.get('since') !== null ? { since: new Date(q.get('since') as string).toISOString() } : {}),
      ...(q.get('until') !== null ? { until: new Date(q.get('until') as string).toISOString() } : {}),
      ...(before !== undefined ? { beforeSeq: before } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return json(200, { events: page.entries, ...(page.nextBeforeSeq !== undefined ? { nextBefore: page.nextBeforeSeq } : {}) });
  }

  async function verifyAudit(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'audit', dataConfig, { action: 'verify audit log' });
    const verification = await auditLog(workspace).verify();
    return json(200, {
      ...verification,
      appendOnly: true,
      tamperEvident: true,
      retention: { minimumDays: declaredRetentionDays(), deletionSupported: false },
    });
  }

  async function exportAudit(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'export audit log' });
    const format = req.query.get('format') ?? 'json';
    if (format !== 'json' && format !== 'csv') throw new XoError(ErrorCode.INVALID_ARGUMENT, '"format" must be "json" or "csv"');
    const log = auditLog(workspace);
    const pack = await buildAuditExport(workspace, log, new Date());
    await recordAudit(req, workspace, dataConfig, {
      event: 'audit.exported',
      result: 'succeeded',
      target: { kind: 'workspace', id: workspace.workspaceId },
      detail: { format, entries: pack.entries.length, headHash: pack.integrity.headHash },
    });
    if (format === 'csv') {
      return {
        status: 200,
        body: Buffer.from(auditExportToCsv(pack), 'utf8'),
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="audit-${workspace.workspaceId}.csv"` },
      };
    }
    return json(200, pack, { 'content-disposition': `attachment; filename="audit-${workspace.workspaceId}.json"` });
  }

  router.get('/workspaces/:workspaceId/audit/events', guarded(listAudit));
  router.get('/workspaces/:workspaceId/audit/verify', guarded(verifyAudit));
  router.get('/workspaces/:workspaceId/audit/export', guarded(exportAudit));
}
