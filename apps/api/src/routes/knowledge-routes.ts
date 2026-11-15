import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal, type AuditEventDraft } from '@xo/audit';
import {
  FsKnowledgeStore,
  KnowledgeBase,
  KnowledgeError,
  IntegrityError,
  reconcileXoirGraph,
  validatePackArtifact,
  type PackArtifact,
  type PrecedencePolicy,
  type XoirGraphView,
} from '@xo/knowledge-base';
import { join } from 'node:path';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import {
  requirePermission,
  requireOwnedWorkspace,
  requirePrincipal,
  workspaceCompilationsStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId, safeId } from '../audit/audit-service.js';

/**
 * PX-4 — the workspace's Business Knowledge Base over HTTP (ADR 0029, spec §4.6).
 *
 * The workspace is the tenant: its knowledge lives in `<dataRootDir>/<workspaceId>/knowledge/<workspaceId>/`, governed by
 * `@xo/knowledge-base`. A compilation never writes knowledge directly: it PROPOSES a change set (author role); a reviewer
 * approves or rejects it (review role, recent sign-in), which is the only way the active state changes. Reads are pinned to
 * a state id (the head when none is given) and return evidence and authority with every record.
 */

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      if (cause instanceof KnowledgeError) {
        if (cause.code === 'not_found') return errorToResponse(new NotFoundError(cause.message));
        if (cause.code === 'integrity')
          return errorToResponse(new XoError(ErrorCode.KNOWLEDGE_INTEGRITY_FAILED, `knowledge base integrity: ${cause.message}`));
        return errorToResponse(
          new XoError(ErrorCode.KNOWLEDGE_CHANGE_SET_REFUSED, cause.message, { context: { knowledgeError: cause.code } }),
        );
      }
      if (cause instanceof IntegrityError)
        return errorToResponse(new XoError(ErrorCode.KNOWLEDGE_INTEGRITY_FAILED, `knowledge base integrity: ${cause.message}`));
      return errorToResponse(cause);
    }
  };
}

export async function workspaceKnowledgeBase(workspace: WorkspaceRecord, config: WorkspaceDataConfig): Promise<KnowledgeBase> {
  return new KnowledgeBase(
    await FsKnowledgeStore.open(join(config.dataRootDir, workspace.workspaceId, 'knowledge'), workspace.workspaceId),
  );
}

function parsePolicy(v: unknown): PrecedencePolicy | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'object' || v === null)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'precedencePolicy must be { version, order: string[] }');
  const { version, order } = v as Record<string, unknown>;
  if (typeof version !== 'string' || !Array.isArray(order) || !order.every((o) => typeof o === 'string'))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'precedencePolicy must be { version: string, order: string[] }');
  return { version, order: order as string[] };
}

export function registerKnowledgeRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };

  async function stateIdOf(req: ApiRequest, kb: KnowledgeBase): Promise<string> {
    return req.query.get('state') ?? (await kb.head()).stateId;
  }

  /** Proposes the knowledge in a compilation as a change set against the head (author role). Nothing is applied. */
  async function proposeFromCompilation(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'knowledge.propose', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'propose knowledge' });
    const compilationId = req.params['compilationId'];
    if (compilationId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing compilation id');
    const compilations = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
    const artifact = await compilations.getArtifact(compilationId);
    if (!artifact.ok) throw artifact.error;
    const graph = await compilations.getCompiledGraph(compilationId);
    if (!graph.ok) throw graph.error;
    const byName = new Map(artifact.value.sourceSet.entries.map((e) => [e.name, e] as const));
    const sources = new Map<string, { name: string; digestSha256: string }>();
    for (const s of (artifact.value.sources as readonly { sourceId: string; sourcePath?: string }[] | undefined) ?? []) {
      const entry = s.sourcePath !== undefined ? byName.get(s.sourcePath) : undefined;
      if (entry !== undefined) sources.set(s.sourceId, { name: entry.name, digestSha256: entry.digestSha256 });
    }
    const actor = requirePrincipal(req);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const { changeSet, report } = await reconcileXoirGraph(kb, graph.value as XoirGraphView, {
      sources,
      origin: {
        kind: 'xoir-reconciliation',
        ref: compilationId,
        sourceSetId: artifact.value.sourceSet.sourceSetId,
        compilationArtifactDigest: artifact.value.digest,
        xoirGraphHash: artifact.value.graph.contentHash,
      },
      proposedBy: { id: actor.id, kind: actor.kind },
      recordedAt: new Date().toISOString(),
    });
    if (changeSet !== undefined)
      await audit.tryRecord({
        action: 'knowledge.propose',
        actor: actorFromPrincipal(actor),
        correlationId,
        target: { kind: 'knowledge-change-set', id: changeSet.changeSetId, workspaceId: workspace.workspaceId },
        type: 'knowledge.change-set.proposed',
        outcome: 'completed',
        metadata: { compilationId: safeId(compilationId) ?? 'unknown', operations: changeSet.operations.length },
      });
    return json(changeSet === undefined ? 200 : 201, { changeSet: changeSet ?? null, report });
  }

  async function decide(req: ApiRequest, kind: 'approve' | 'reject'): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const action = `knowledge.${kind}`;
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action, correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: `${kind} a knowledge change set` });
    await requireRecentAuthentication(req, workspace, dataConfig, `${kind} a knowledge change set`);
    const changeSetId = req.params['changeSetId'];
    if (changeSetId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing change set id');
    const body = await req.json<{ reason?: unknown; precedencePolicy?: unknown }>();
    if (!body.ok) throw body.error;
    const reason = body.value.reason;
    if (typeof reason !== 'string' || reason.trim() === '')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'body must be { reason: string }');
    const actor = requirePrincipal(req);
    const draft = {
      action,
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'knowledge-change-set' as const, id: safeId(changeSetId) ?? 'unknown', workspaceId: workspace.workspaceId },
    } satisfies Omit<AuditEventDraft, 'type' | 'outcome'>;
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const reviewer = { id: actor.id, kind: actor.kind };
    try {
      if (kind === 'approve') {
        const state = await kb.approve(changeSetId, reviewer, reason, parsePolicy(body.value.precedencePolicy));
        await audit.tryRecord({
          ...draft,
          type: 'knowledge.change-set.approved',
          outcome: 'completed',
          metadata: { stateId: state.stateId },
        });
        return json(200, { changeSet: await kb.changeSet(changeSetId), state });
      }
      await kb.reject(changeSetId, reviewer, reason);
      await audit.tryRecord({ ...draft, type: 'knowledge.change-set.rejected', outcome: 'completed' });
      return json(200, { changeSet: await kb.changeSet(changeSetId) });
    } catch (cause) {
      if (cause instanceof KnowledgeError && cause.code !== 'not_found')
        await audit.tryRecord({ ...draft, type: 'knowledge.change-set.denied', outcome: 'denied', reasonCode: cause.code });
      throw cause;
    }
  }

  async function listChangeSets(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const status = req.query.get('status');
    const all = await kb.changeSets();
    return json(200, { changeSets: status === null ? all : all.filter((c) => c.status === status) });
  }

  async function getChangeSet(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    return json(200, await (await workspaceKnowledgeBase(workspace, dataConfig)).changeSet(req.params['changeSetId'] ?? ''));
  }

  async function getState(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const id = req.params['stateId'];
    return json(200, id === undefined ? await kb.head() : await kb.state(id));
  }

  async function verifyState(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const id = req.params['stateId'] ?? '';
    const findings = await kb.verifyState(id);
    return json(200, { stateId: id, verified: findings.length === 0, findings });
  }

  async function listRecords(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const stateId = await stateIdOf(req, kb);
    const kind = req.query.get('kind');
    const lifecycle = req.query.get('lifecycle');
    const type = req.query.get('type');
    if (kind !== null && kind !== 'entity' && kind !== 'claim' && kind !== 'relationship')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'kind must be entity, claim or relationship');
    const records = await kb.records(stateId, {
      ...(kind !== null ? { kind } : {}),
      ...(type !== null ? { type } : {}),
      ...(lifecycle !== null ? { lifecycle: lifecycle as 'any' } : {}),
    });
    return json(200, { stateId, records });
  }

  async function search(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const q = req.query.get('q');
    if (q === null || q.trim() === '') throw new XoError(ErrorCode.INVALID_ARGUMENT, 'q is required');
    const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') ?? '10') || 10));
    const stateId = await stateIdOf(req, kb);
    return json(200, { stateId, hits: await kb.search(stateId, q, limit) });
  }

  async function resolveEntity(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const name = req.query.get('name');
    if (name === null || name.trim() === '') throw new XoError(ErrorCode.INVALID_ARGUMENT, 'name is required');
    const type = req.query.get('type');
    const stateId = await stateIdOf(req, kb);
    return json(200, { stateId, ...(await kb.resolveEntity(stateId, { name, ...(type !== null ? { type } : {}) })) });
  }

  async function listConflicts(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const state = await kb.state(await stateIdOf(req, kb));
    return json(200, { stateId: state.stateId, conflicts: state.conflicts });
  }

  async function listPacks(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    return json(200, { packs: (await kb.packs()).bindings() });
  }

  /** Installs a Domain Knowledge Pack for the workspace (manage role, recent sign-in). A pack adds semantics, not authority. */
  async function installPack(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'knowledge.install-pack', correlationId });
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'install a knowledge pack' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'install a knowledge pack');
    const body = await req.json<PackArtifact>();
    if (!body.ok) throw body.error;
    const pack = body.value;
    if (typeof pack !== 'object' || pack === null || typeof pack.manifest !== 'object' || pack.manifest === null)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'body must be a pack artifact { manifest, digest }');
    const problems = validatePackArtifact(pack);
    if (problems.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `invalid pack: ${problems.join('; ')}`);
    const actor = requirePrincipal(req);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    try {
      await kb.installPack(pack, { id: actor.id, kind: actor.kind });
    } catch (cause) {
      if (cause instanceof KnowledgeError) throw cause;
      throw new XoError(ErrorCode.KNOWLEDGE_PACK_REFUSED, cause instanceof Error ? cause.message : String(cause));
    }
    await audit.tryRecord({
      action: 'knowledge.install-pack',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'knowledge-pack', id: safeId(pack.manifest.packId) ?? 'pack', workspaceId: workspace.workspaceId },
      type: 'knowledge.pack.installed',
      outcome: 'completed',
      metadata: { namespace: pack.manifest.namespace, version: pack.manifest.version },
    });
    return json(201, { packs: (await kb.packs()).bindings() });
  }

  router.post('/workspaces/:workspaceId/compilations/:compilationId/knowledge-change-sets', guarded(proposeFromCompilation));
  router.get('/workspaces/:workspaceId/knowledge/change-sets', guarded(listChangeSets));
  router.get('/workspaces/:workspaceId/knowledge/change-sets/:changeSetId', guarded(getChangeSet));
  router.post(
    '/workspaces/:workspaceId/knowledge/change-sets/:changeSetId/approve',
    guarded((req) => decide(req, 'approve')),
  );
  router.post(
    '/workspaces/:workspaceId/knowledge/change-sets/:changeSetId/reject',
    guarded((req) => decide(req, 'reject')),
  );
  router.get('/workspaces/:workspaceId/knowledge/state', guarded(getState));
  router.get('/workspaces/:workspaceId/knowledge/states/:stateId', guarded(getState));
  router.get('/workspaces/:workspaceId/knowledge/states/:stateId/verify', guarded(verifyState));
  router.get('/workspaces/:workspaceId/knowledge/records', guarded(listRecords));
  router.get('/workspaces/:workspaceId/knowledge/search', guarded(search));
  router.get('/workspaces/:workspaceId/knowledge/resolve-entity', guarded(resolveEntity));
  router.get('/workspaces/:workspaceId/knowledge/conflicts', guarded(listConflicts));
  router.get('/workspaces/:workspaceId/knowledge/packs', guarded(listPacks));
  router.post('/workspaces/:workspaceId/knowledge/packs', guarded(installPack));
}
