/**
 * UW-12a (ADR 0038) — workspace source connections over HTTP.
 *
 *   GET  /workspaces/:ws/source-connections                       list (read role)
 *   POST /workspaces/:ws/source-connections                       connect a folder (manage role, recent sign-in); syncs it at once
 *   GET  /workspaces/:ws/source-connections/:id                   detail: files, freshness, last sync, proposed roles (read role)
 *   POST /workspaces/:ws/source-connections/:id/sync              sync now (author role)
 *   PUT  /workspaces/:ws/source-connections/:id/schedule          manual, or every N minutes (manage role)
 *   POST /workspaces/:ws/source-connections/:id/pause|resume      stop or restart syncing (manage role)
 *   POST /workspaces/:ws/source-connections/:id/retire            retire it and every version it holds (manage role, recent sign-in)
 *   POST /workspaces/:ws/source-connections/:id/proposals/:pid/decision   confirm or reject a proposed role (author role)
 *   GET  /workspaces/:ws/discovery                                what the active connections hold, as proposals, and the message (read)
 *   POST /workspaces/:ws/discovery/conversation                   start a conversation with that message (any member; it is theirs)
 *
 * The approved folder path is never returned: a connection shows the folder's last segment. Every change is audited.
 */
import {
  FolderError,
  approveRoot,
  discoveryMessage,
  folderDisplayName,
  driveFolderName,
  listDriveFolders,
  freshnessOf,
  proposalDigests,
  proposalViews,
  type ProposalView,
  type SourceConnection,
} from '@xo/connect';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFor, recordAudit } from '../audit/record.js';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import { json, type ApiRequest } from '../http/types.js';
import { FsConversationStore, MAX_CONVERSATIONS_PER_IDENTITY } from '../intelligence/conversation-store.js';
import { discoveryItems, retireConnection, sourceFolderRoots, syncConnection, type SyncDeps } from '../source-connections/sync.js';
import { driveHttp, readerFor } from '../source-connections/readers.js';
import { PAIRING_TTL_MS, agentLastSeen, newPairingCode, revokePairings, savePairing } from '../source-connections/agent-pairing.js';
import type { AuditService } from '../audit/audit-service.js';
import { FsSourceConnectionStore, newConnectionId } from '../source-connections/store.js';
import {
  callerIdentityId,
  requireOwnedWorkspace,
  requirePermission,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/** A connection as the API shows it: never the folder path. */
export function connectionView(c: SourceConnection, now = new Date()): Record<string, unknown> {
  return {
    connectionId: c.connectionId,
    kind: c.kind,
    displayName: c.displayName,
    sync: c.sync,
    paused: c.paused,
    ...(c.remote !== undefined ? { remote: { provider: c.remote.provider, credentialId: c.remote.credentialId } } : {}),
    ...(c.kind === 'agent_folder'
      ? {
          agent: {
            paired: c.agent?.tokenHash !== undefined,
            ...(c.agent?.label !== undefined ? { label: c.agent.label } : {}),
            ...(c.agent?.platform !== undefined ? { platform: c.agent.platform } : {}),
            ...(c.agent?.pairedAt !== undefined ? { pairedAt: c.agent.pairedAt } : {}),
            ...(c.agent?.pairingExpiresAt !== undefined ? { pairingExpiresAt: c.agent.pairingExpiresAt } : {}),
            ...(c.agent?.syncRequestedAt !== undefined ? { syncRequestedAt: c.agent.syncRequestedAt } : {}),
          },
        }
      : {}),
    ...(c.retiredAt !== undefined ? { retiredAt: c.retiredAt } : {}),
    freshness: freshnessOf(c, now),
    createdAt: c.createdAt,
    createdBy: c.createdBy,
    revision: c.revision,
    updatedAt: c.updatedAt,
    files: c.items.length,
    ...(c.lastSync !== undefined ? { lastSync: c.lastSync } : {}),
    proposals: proposalViews(c).length,
  };
}

function detailView(c: SourceConnection, now = new Date()): Record<string, unknown> {
  return {
    ...connectionView(c, now),
    items: c.items.map((i) => ({
      key: i.key,
      name: i.name,
      extension: i.extension,
      sizeBytes: i.sizeBytes,
      modifiedAt: i.modifiedAt,
      sourceId: i.sourceId,
      syncedAt: i.syncedAt,
    })),
    retired: c.retired.slice(-50),
    proposals: proposalViews(c),
  };
}

function folderProblem(e: FolderError): XoError {
  return new XoError(e.code === 'root_not_allowed' ? ErrorCode.PRECONDITION_FAILED : ErrorCode.INVALID_ARGUMENT, e.message, {
    context: { reason: e.code },
  });
}

export function registerSourceConnectionRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  env: Readonly<Record<string, string | undefined>>,
  audit?: AuditService,
): void {
  const BASE = '/workspaces/:workspaceId/source-connections';
  const store = (w: WorkspaceRecord) => new FsSourceConnectionStore(w, dataConfig);
  const deps = (req: ApiRequest, w: WorkspaceRecord): SyncDeps => ({
    workspace: w,
    dataConfig,
    readerFor: (c) => readerFor({ workspace: w, dataConfig, env, ...(audit !== undefined ? { audit } : {}) }, c),
    actor: actorFor(req, w),
  });
  const readerContext = (w: WorkspaceRecord) => ({ workspace: w, dataConfig, env, ...(audit !== undefined ? { audit } : {}) });
  /** The pairing the person shows the agent: once, now. */
  const pairing = async (w: WorkspaceRecord, connectionId: string, now: Date) => {
    const code = newPairingCode();
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS).toISOString();
    await revokePairings(dataConfig.dataRootDir, connectionId, now);
    await savePairing(dataConfig.dataRootDir, code, { workspaceId: w.workspaceId, connectionId, expiresAt });
    const server = env['XO_PUBLIC_BASE_URL'] ?? '<this instance’s address>';
    return { code, expiresAt, command: `xo agent pair --server ${server} --code ${code} --folder <the folder on your computer>` };
  };
  const driveProblem = (e: FolderError): XoError =>
    new XoError(e.code === 'credential_unusable' ? ErrorCode.PRECONDITION_FAILED : ErrorCode.INVALID_ARGUMENT, e.message, {
      context: { reason: e.code },
    });
  const body = async (req: ApiRequest, allowed: readonly string[]): Promise<Record<string, unknown>> => {
    if ((await req.rawBody()).length === 0) return {};
    const b = await req.json<Record<string, unknown>>();
    if (!b.ok) throw b.error;
    if (typeof b.value !== 'object' || b.value === null || Array.isArray(b.value))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'the body is a JSON object');
    const unknown = Object.keys(b.value).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ').slice(0, 200)}`);
    return b.value;
  };
  const revisionOf = (b: Record<string, unknown>): number | undefined => {
    const r = b['expectedRevision'];
    if (r === undefined) return undefined;
    if (typeof r !== 'number' || !Number.isInteger(r) || r < 1)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"expectedRevision" is a positive whole number');
    return r;
  };
  const syncPolicy = (v: unknown): SourceConnection['sync'] => {
    if (v === undefined) return { mode: 'manual' };
    const o = v as { mode?: unknown; everyMinutes?: unknown };
    if (typeof o === 'object' && o !== null && o.mode === 'manual' && Object.keys(o).length === 1) return { mode: 'manual' };
    if (
      typeof o === 'object' &&
      o !== null &&
      o.mode === 'interval' &&
      typeof o.everyMinutes === 'number' &&
      Number.isInteger(o.everyMinutes) &&
      o.everyMinutes >= MIN_INTERVAL_MINUTES &&
      o.everyMinutes <= MAX_INTERVAL_MINUTES
    )
      return { mode: 'interval', everyMinutes: o.everyMinutes };
    throw new XoError(
      ErrorCode.INVALID_ARGUMENT,
      `"sync" is { "mode": "manual" } or { "mode": "interval", "everyMinutes": ${MIN_INTERVAL_MINUTES}…${MAX_INTERVAL_MINUTES} }`,
    );
  };
  const target = (c: SourceConnection) => ({ kind: 'source-connection', id: c.connectionId, label: c.displayName });

  router.get(BASE, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'read', dataConfig);
    const all = await store(w).list();
    const showRetired = req.query.get('retired') === 'true';
    return json(200, { connections: all.filter((c) => showRetired || c.retiredAt === undefined).map((c) => connectionView(c)) });
  });

  router.post(BASE, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    const action = 'source-connection.create';
    await requirePermission(req, w, 'manage', dataConfig, { action: 'connect a folder' });
    await requireRecentAuthentication(req, w, dataConfig, action);
    const b = await body(req, ['kind', 'root', 'sync', 'credentialId', 'folder']);
    const kind = b['kind'];
    if (kind !== 'local_folder' && kind !== 'agent_folder' && kind !== 'microsoft_drive' && kind !== 'google_drive')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"kind" is local_folder, agent_folder, microsoft_drive or google_drive');
    const sync = syncPolicy(b['sync']);
    const active = (await store(w).list()).filter((c) => c.retiredAt === undefined);
    let place: Pick<SourceConnection, 'displayName' | 'root' | 'remote'>;
    if (kind === 'local_folder') {
      if (typeof b['root'] !== 'string' || b['root'].length > 4096)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"root" is the folder’s absolute path');
      let root: string;
      try {
        root = await approveRoot(b['root'], sourceFolderRoots(env));
      } catch (e) {
        if (e instanceof FolderError) throw folderProblem(e);
        throw e;
      }
      const existing = active.find((c) => c.root === root);
      if (existing !== undefined)
        throw new XoError(ErrorCode.ALREADY_EXISTS, `this folder is already connected (${existing.connectionId})`, {
          context: { connectionId: existing.connectionId },
        });
      place = { displayName: folderDisplayName(root), root };
    } else if (kind === 'agent_folder') {
      // The folder is chosen on the computer, when the agent pairs; until then it has no name.
      place = { displayName: 'Folder on a computer (not paired yet)' };
    } else {
      const provider = kind === 'microsoft_drive' ? 'microsoft' : 'google';
      const credentialId = b['credentialId'];
      const folder = b['folder'];
      if (typeof credentialId !== 'string' || !/^crd_[0-9a-f]{24}$/.test(credentialId))
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"credentialId" names a connected account (crd_…) with the files.read capability');
      if (typeof folder !== 'string' || folder.length > 600)
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"folder" is the folder chosen from GET …/source-connections/drive-folders');
      const existing = active.find((c) => c.remote?.provider === provider && c.remote.folder === folder);
      if (existing !== undefined)
        throw new XoError(ErrorCode.ALREADY_EXISTS, `this folder is already connected (${existing.connectionId})`, {
          context: { connectionId: existing.connectionId },
        });
      let name: string;
      try {
        name = await driveFolderName(provider, await driveHttp(readerContext(w), credentialId, provider), folder);
      } catch (e) {
        if (e instanceof FolderError) throw driveProblem(e);
        throw e;
      }
      place = { displayName: name.slice(0, 120), remote: { provider, credentialId, folder } };
    }
    const now = new Date();
    const created = await store(w).create({
      connectionId: newConnectionId(),
      kind,
      ...place,
      sync,
      ...(kind === 'agent_folder' ? { agent: { pairingExpiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString() } } : {}),
      paused: false,
      createdAt: now.toISOString(),
      createdBy: callerIdentityId(req),
      updatedAt: now.toISOString(),
      items: [],
      retired: [],
      proposals: [],
      decisions: [],
    });
    await recordAudit(req, w, dataConfig, {
      event: 'source_connection.created',
      result: 'succeeded',
      target: target(created),
      detail: {
        kind: created.kind,
        sync: created.sync.mode,
        ...(created.sync.mode === 'interval' ? { everyMinutes: created.sync.everyMinutes } : {}),
      },
    });
    if (kind === 'agent_folder') {
      const p = await pairing(w, created.connectionId, now);
      const withExpiry = await store(w).update(created.connectionId, undefined, now, (cur) => ({
        ...cur,
        agent: { ...cur.agent, pairingExpiresAt: p.expiresAt },
      }));
      return json(201, { connection: detailView(withExpiry), pairing: p });
    }
    const synced = await syncConnection(deps(req, w), created.connectionId, now);
    return json(201, { connection: detailView(synced) });
  });

  // Registered before `/:id`, so `drive-folders` is never read as a connection id.
  router.get(`${BASE}/drive-folders`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'manage', dataConfig, { action: 'browse a drive to choose a folder' });
    const credentialId = req.query.get('credentialId') ?? '';
    const provider = req.query.get('provider');
    if (!/^crd_[0-9a-f]{24}$/.test(credentialId)) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"credentialId" names a connected account');
    if (provider !== 'microsoft' && provider !== 'google')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"provider" is microsoft or google');
    const parent = req.query.get('parent') ?? undefined;
    try {
      const folders = await listDriveFolders(provider, await driveHttp(readerContext(w), credentialId, provider), parent);
      return json(200, { folders });
    } catch (e) {
      if (e instanceof FolderError) throw driveProblem(e);
      throw e;
    }
  });

  const one = async (req: ApiRequest, w: WorkspaceRecord) => store(w).require(req.params['id'] ?? '');

  router.get(`${BASE}/:id`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'read', dataConfig);
    const c = await one(req, w);
    const view = detailView(c);
    if (c.kind === 'agent_folder') {
      const seen = await agentLastSeen(dataConfig.dataRootDir, w.workspaceId, c.connectionId);
      if (seen !== undefined) (view['agent'] as Record<string, unknown>)['lastSeenAt'] = seen;
    }
    return json(200, { connection: view });
  });

  router.post(`${BASE}/:id/sync`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'sync a source connection' });
    const c = await one(req, w);
    if (c.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is retired');
    if (c.paused) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is paused; resume it first');
    if (c.kind === 'agent_folder') {
      // The agent on the computer does the reading: it sees the request at its next check (about a minute).
      if (c.agent?.tokenHash === undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'the agent on the computer is not paired yet');
      const now = new Date();
      const next = await store(w).update(c.connectionId, undefined, now, (cur) => ({
        ...cur,
        agent: { ...cur.agent, syncRequestedAt: now.toISOString() },
      }));
      return json(202, { connection: detailView(next) });
    }
    return json(200, { connection: detailView(await syncConnection(deps(req, w), c.connectionId)) });
  });

  const change = (
    path: string,
    label: string,
    allowed: readonly string[],
    apply: (c: SourceConnection, b: Record<string, unknown>) => Partial<SourceConnection>,
  ) =>
    router[path.endsWith('schedule') ? 'put' : 'post'](`${BASE}/:id/${path}`, async (req) => {
      const w = await requireOwnedWorkspace(req, workspaceStore);
      await requirePermission(req, w, 'manage', dataConfig, { action: label });
      const b = await body(req, [...allowed, 'expectedRevision']);
      const c = await one(req, w);
      if (c.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is retired');
      const patch = apply(c, b);
      const next = await store(w).update(c.connectionId, revisionOf(b), new Date(), (cur) => ({ ...cur, ...patch }));
      await recordAudit(req, w, dataConfig, {
        event: 'source_connection.changed',
        result: 'succeeded',
        target: target(next),
        detail: { change: path },
      });
      return json(200, { connection: detailView(next) });
    });
  change('schedule', 'change how a source connection syncs', ['sync'], (_c, b) => ({ sync: syncPolicy(b['sync']) }));
  change('pause', 'pause a source connection', [], (c) => {
    if (c.paused) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is already paused');
    return { paused: true };
  });
  change('resume', 'resume a source connection', [], (c) => {
    if (!c.paused) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is not paused');
    return { paused: false };
  });

  router.post(`${BASE}/:id/retire`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    const action = 'source-connection.retire';
    await requirePermission(req, w, 'manage', dataConfig, { action: 'retire a source connection' });
    await requireRecentAuthentication(req, w, dataConfig, action);
    const b = await body(req, ['expectedRevision']);
    const c = await one(req, w);
    const retired = await retireConnection(deps(req, w), c.connectionId, revisionOf(b));
    await revokePairings(dataConfig.dataRootDir, c.connectionId);
    return json(200, { connection: detailView(retired) });
  });

  router.post(`${BASE}/:id/agent/pair`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    const action = 'source-connection.agent-pair';
    await requirePermission(req, w, 'manage', dataConfig, { action: 'pair the agent on a computer' });
    await requireRecentAuthentication(req, w, dataConfig, action);
    const c = await one(req, w);
    if (c.kind !== 'agent_folder') throw new XoError(ErrorCode.INVALID_ARGUMENT, 'only a folder on a computer has an agent');
    if (c.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is retired');
    const now = new Date();
    const p = await pairing(w, c.connectionId, now);
    // A new pairing revokes the agent that was paired before: its token no longer opens the connection.
    const next = await store(w).update(c.connectionId, undefined, now, (cur) => ({ ...cur, agent: { pairingExpiresAt: p.expiresAt } }));
    await recordAudit(req, w, dataConfig, {
      event: 'source_connection.changed',
      result: 'succeeded',
      target: target(next),
      detail: { change: 'agent_pairing' },
    });
    return json(200, { connection: detailView(next), pairing: p });
  });

  router.post(`${BASE}/:id/proposals/:proposalId/decision`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'confirm or reject what a file is' });
    const b = await body(req, ['decision', 'expectedRevision']);
    const decision = b['decision'];
    if (decision !== 'confirmed' && decision !== 'rejected')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"decision" is confirmed or rejected');
    const c = await one(req, w);
    if (c.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is retired');
    const proposalId = req.params['proposalId'] ?? '';
    const now = new Date();
    const next = await store(w).update(c.connectionId, revisionOf(b), now, (cur) => {
      const p = cur.proposals.find((x) => x.proposalId === proposalId);
      if (p === undefined) throw new NotFoundError(`proposal "${proposalId.slice(0, 40)}" (not current for this connection)`);
      return {
        ...cur,
        decisions: [
          ...cur.decisions.filter((d) => d.proposalId !== proposalId),
          { proposalId, decision, by: callerIdentityId(req), at: now.toISOString(), digests: proposalDigests(p, cur.items) },
        ],
      };
    });
    const p = next.proposals.find((x) => x.proposalId === proposalId)!;
    await recordAudit(req, w, dataConfig, {
      event: 'source_connection.role_decided',
      result: decision === 'confirmed' ? 'approved' : 'rejected',
      target: target(next),
      detail: { proposalId, role: p.role },
    });
    return json(200, { connection: detailView(next) });
  });

  // ---- discovery: what the active connections hold, and the message XO opens a conversation with ----

  const discovery = async (w: WorkspaceRecord, only?: readonly string[]) => {
    const active = (await store(w).list()).filter(
      (c) => c.retiredAt === undefined && (only === undefined || only.includes(c.connectionId)),
    );
    const connections = [];
    const proposals: (ProposalView & { readonly connectionId: string })[] = [];
    for (const c of active) {
      connections.push({ displayName: c.displayName, items: await discoveryItems({ workspace: w, dataConfig }, c) });
      for (const p of proposalViews(c)) proposals.push({ ...p, connectionId: c.connectionId });
    }
    return {
      connections: active.map((c) => connectionView(c)),
      proposals,
      message: discoveryMessage({ connections, proposals }),
    };
  };

  router.get('/workspaces/:workspaceId/discovery', async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'read', dataConfig);
    return json(200, await discovery(w));
  });

  router.post('/workspaces/:workspaceId/discovery/conversation', async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'read', dataConfig);
    const b = await body(req, ['connectionIds']);
    const ids = b['connectionIds'];
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 50 || ids.some((x) => typeof x !== 'string')))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"connectionIds" is a list of source connection ids');
    const d = await discovery(w, ids as string[] | undefined);
    if (d.connections.length === 0)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, 'no active source connection to talk about; connect a folder first');
    const conversations = new FsConversationStore(workspaceStateStore(w, dataConfig), w.workspaceId);
    if ((await conversations.listOwned(callerIdentityId(req))).length >= MAX_CONVERSATIONS_PER_IDENTITY)
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        `you have reached the limit of ${MAX_CONVERSATIONS_PER_IDENTITY} conversations; delete some first`,
      );
    const now = new Date();
    const c = await conversations.create(callerIdentityId(req), 'What I found', now);
    const withMessage = await conversations.append(
      c.conversationId,
      [
        {
          role: 'assistant',
          content: d.message,
          discovery: {
            connectionIds: d.connections.map((x) => x.connectionId as string),
            proposals: d.proposals
              .filter((p) => p.status !== 'rejected')
              .map((p) => ({
                connectionId: p.connectionId,
                proposalId: p.proposalId,
                role: p.role,
                label: p.label,
                basis: p.basis,
                strength: p.strength,
                status: p.status,
              })),
          },
        },
      ],
      now,
    );
    return json(201, withMessage ?? c);
  });
}
