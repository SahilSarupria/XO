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
): void {
  const BASE = '/workspaces/:workspaceId/source-connections';
  const store = (w: WorkspaceRecord) => new FsSourceConnectionStore(w, dataConfig);
  const deps = (req: ApiRequest, w: WorkspaceRecord): SyncDeps => ({
    workspace: w,
    dataConfig,
    allowedRoots: sourceFolderRoots(env),
    actor: actorFor(req, w),
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
    const b = await body(req, ['kind', 'root', 'sync']);
    if (b['kind'] !== 'local_folder')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"kind" must be local_folder (cloud drives come later)');
    if (typeof b['root'] !== 'string' || b['root'].length > 4096)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"root" is the folder’s absolute path');
    const sync = syncPolicy(b['sync']);
    let root: string;
    try {
      root = await approveRoot(b['root'], sourceFolderRoots(env));
    } catch (e) {
      if (e instanceof FolderError) throw folderProblem(e);
      throw e;
    }
    const existing = (await store(w).list()).find((c) => c.retiredAt === undefined && c.root === root);
    if (existing !== undefined)
      throw new XoError(ErrorCode.ALREADY_EXISTS, `this folder is already connected (${existing.connectionId})`, {
        context: { connectionId: existing.connectionId },
      });
    const now = new Date();
    const created = await store(w).create({
      connectionId: newConnectionId(),
      kind: 'local_folder',
      displayName: folderDisplayName(root),
      root,
      sync,
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
    const synced = await syncConnection(deps(req, w), created.connectionId, now);
    return json(201, { connection: detailView(synced) });
  });

  const one = async (req: ApiRequest, w: WorkspaceRecord) => store(w).require(req.params['id'] ?? '');

  router.get(`${BASE}/:id`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'read', dataConfig);
    return json(200, { connection: detailView(await one(req, w)) });
  });

  router.post(`${BASE}/:id/sync`, async (req) => {
    const w = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, w, 'author', dataConfig, { action: 'sync a source connection' });
    const c = await one(req, w);
    if (c.retiredAt !== undefined) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is retired');
    if (c.paused) throw new XoError(ErrorCode.PRECONDITION_FAILED, 'this source connection is paused; resume it first');
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
    return json(200, { connection: detailView(await retireConnection(deps(req, w), c.connectionId, revisionOf(b))) });
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
