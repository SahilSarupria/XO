import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { actorFromPrincipal, type AuditEventDraft } from '@xo/audit';
import {
  FsKnowledgeStore,
  SqlKnowledgeStore,
  sqliteDriver,
  KnowledgeBase,
  type KnowledgeStore,
  type SqlDriver,
  KnowledgeError,
  IntegrityError,
  copyKnowledge,
  DerivationRefused,
  deriveClaimsFromText,
  executableKnowledge,
  isKnowledgeStoreEmpty,
  reconcileXoirGraph,
  validatePackArtifact,
  type ChangeOperation,
  type ChangeSet,
  type KnowledgeState,
  type PackArtifact,
  type PrecedencePolicy,
  type ValidationFinding,
  type XoirGraphView,
} from '@xo/knowledge-base';
import { dirname, join } from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { pg, postgresDriver } from '@xo/knowledge-store-postgres';
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
  workspaceSourcesStore,
  workspaceStateStore,
  type WorkspaceDataConfig,
} from '../workspace/workspace-context.js';
import { WorkspaceEvidenceSources } from '../knowledge/evidence-sources.js';
import { resolveResidency, type ResidencyPolicy } from '@xo/ai-core';
import { envProviderFactory, guardedFactory, type ProviderFactory } from '../chat/model-provider.js';
import { usableModelChoices } from '../chat/usable-models.js';
import { FsSettingsStore } from '../settings/fs-settings-store.js';
import { FsSourceStore } from '../sources/fs-source-store.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import { FsCompilationStore } from '../compilations/fs-compilation-store.js';
import { workspaceCertificatesStore } from './readiness-routes.js';
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

/** One driver per database for the life of the process (the SQLite file or the Postgres pool), shared by every workspace. */
const drivers = new Map<string, Promise<SqlDriver>>();
/** Opened stores by database and tenant: opening runs the schema check once, not on every request. */
const stores = new Map<string, Promise<KnowledgeStore>>();

function driverFor(kind: 'sqlite' | 'postgres', target: string): Promise<SqlDriver> {
  const key = `${kind}:${target}`;
  let d = drivers.get(key);
  if (d === undefined) {
    d =
      kind === 'sqlite'
        ? mkdir(dirname(target), { recursive: true }).then(() => sqliteDriver(target))
        : Promise.resolve(postgresDriver(new pg.Pool({ connectionString: target, max: 10 }), { ownsPool: true }));
    d.catch(() => drivers.delete(key));
    drivers.set(key, d);
  }
  return d;
}

/**
 * ADR 0031 — the deployment transition from the file store. Knowledge a workspace kept in files (before SQL became the
 * default) is copied into the SQL store the first time the workspace's knowledge is opened: every row through both stores'
 * integrity checks, the event chain replayed digest for digest (`copyKnowledge`). The files are left in place, marked with
 * where they went, and never read again. A SQL store that already holds knowledge for the workspace is never merged
 * into: that is an operator decision, reported as an error until it is made.
 */
async function importLegacyFileKnowledge(root: string, target: KnowledgeStore, kind: string): Promise<void> {
  const tenantDir = join(root, target.tenantId);
  const marker = join(tenantDir, 'MIGRATED.json');
  const legacyEvents = await stat(join(tenantDir, 'events.jsonl')).catch(() => undefined);
  if (legacyEvents === undefined || (await stat(marker).catch(() => undefined)) !== undefined) return;
  const legacy = await FsKnowledgeStore.open(root, target.tenantId);
  if ((await legacy.events()).length === 0) return;
  if (!(await isKnowledgeStoreEmpty(target)))
    throw new XoError(
      ErrorCode.KNOWLEDGE_INTEGRITY_FAILED,
      `workspace ${target.tenantId} has knowledge both in files (${tenantDir}) and in the ${kind} store; they are never merged. Keep one: move the files aside, or set XO_KNOWLEDGE_STORE=file`,
    );
  const report = await copyKnowledge(legacy, target);
  await writeFile(marker, JSON.stringify({ migratedTo: kind, at: new Date().toISOString(), ...report }, null, 2), { flag: 'wx' });
}

/** ADR 0030 — the workspace's knowledge store, from `dataConfig.knowledgeStore` (SQLite by default). */
export async function workspaceKnowledgeStore(workspace: WorkspaceRecord, config: WorkspaceDataConfig): Promise<KnowledgeStore> {
  const kind = config.knowledgeStore?.kind ?? 'sqlite';
  if (kind === 'file') return FsKnowledgeStore.open(join(config.dataRootDir, workspace.workspaceId, 'knowledge'), workspace.workspaceId);
  const target = kind === 'postgres' ? (config.knowledgeStore?.url ?? '') : join(config.dataRootDir, 'knowledge.sqlite');
  const key = `${kind}:${target}:${workspace.workspaceId}`;
  let s = stores.get(key);
  if (s === undefined) {
    s = driverFor(kind, target)
      .then((driver) => SqlKnowledgeStore.open(driver, workspace.workspaceId))
      .then(async (store) => {
        await importLegacyFileKnowledge(join(config.dataRootDir, workspace.workspaceId, 'knowledge'), store, kind);
        return store;
      });
    s.catch(() => stores.delete(key));
    stores.set(key, s);
  }
  return s;
}

export async function workspaceKnowledgeBase(workspace: WorkspaceRecord, config: WorkspaceDataConfig): Promise<KnowledgeBase> {
  return new KnowledgeBase(await workspaceKnowledgeStore(workspace, config));
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

/**
 * UW-11a: the certified workflows a change would make need a new certificate: for each v3 certificate that still allows a start,
 * the dependency root under the state approval would create is compared with the one the certificate bound.
 */
async function affectedCertificates(
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  kb: KnowledgeBase,
  nextState: KnowledgeState,
): Promise<{ readonly count: number; readonly certificates: readonly { certificateId: string; definitionId?: string }[] }> {
  const certs = await workspaceCertificatesStore(workspace, dataConfig).list();
  const compilations = new FsCompilationStore(workspaceCompilationsStore(workspace, dataConfig));
  const out: { certificateId: string; definitionId?: string }[] = [];
  let count = 0;
  for (const c of certs) {
    if (c.bindings.knowledgeDependencyRoot === undefined) continue;
    if (c.status !== 'READY' && c.status !== 'READY_WITH_CONDITIONS') continue;
    if (c.scope.compilationId === undefined) continue;
    const artifact = await compilations.getArtifact(c.scope.compilationId);
    if (!artifact.ok) continue;
    const digests = new Set(artifact.value.sourceSet.entries.map((e) => e.digestSha256));
    if ((await kb.dependencyRootOf(nextState, digests)) !== c.bindings.knowledgeDependencyRoot) {
      count += 1;
      if (out.length < 200)
        out.push({ certificateId: c.certificateId, ...(c.scope.definitionId !== undefined ? { definitionId: c.scope.definitionId } : {}) });
    }
  }
  return { count, certificates: out };
}

/** The warning added to a proposal: how many certified workflows approval would make need a new certificate. */
async function affectedWarning(
  workspace: WorkspaceRecord,
  dataConfig: WorkspaceDataConfig,
  kb: KnowledgeBase,
  operations: readonly ChangeOperation[],
  origin: ChangeSet['origin'],
): Promise<readonly ValidationFinding[]> {
  void operations;
  void origin;
  const head = await kb.head();
  const certs = await workspaceCertificatesStore(workspace, dataConfig).list();
  // A proposal's effect is only known once it exists; the cheap, honest warning is the number of certified workflows now.
  const certified = certs.filter(
    (c) => c.bindings.knowledgeDependencyRoot !== undefined && (c.status === 'READY' || c.status === 'READY_WITH_CONDITIONS'),
  );
  void head;
  return certified.length === 0
    ? []
    : [
        {
          severity: 'warning',
          code: 'affects-certified-workflows',
          message: `${certified.length} certified workflow(s) exist; the preview shows which would need a new certificate`,
        },
      ];
}

export interface KnowledgeRouteOptions {
  /** The model providers (tests inject one); every one passes the residency guard. */
  readonly providerFactory?: ProviderFactory;
  readonly residency?: ResidencyPolicy;
}

export function registerKnowledgeRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  options: KnowledgeRouteOptions = {},
): void {
  const auditCtx = { audit, workspaceStore };
  // UW-4c: the K4 deriver reaches a model only through the residency-guarded factory (UW-14), like chat.
  const residency = options.residency ?? resolveResidency(process.env);
  const providerFor = guardedFactory(options.providerFactory ?? envProviderFactory(process.env, residency), residency);

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

  /**
   * UW-4c (K4): a model reads a stored source's text and proposes claims (author role). Each claim must quote the page it names;
   * the rest are refused and reported by position and reason. The result is a change set for a reviewer, never a state.
   */
  async function deriveFromSource(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'knowledge.derive', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'derive knowledge from a source' });
    const sourceId = req.params['sourceId'] ?? '';
    const record = await new FsSourceStore(workspaceSourcesStore(workspace, dataConfig)).get(sourceId);
    if (!record.ok) throw record.error;
    const view = await new WorkspaceEvidenceSources(workspaceSourcesStore(workspace, dataConfig)).source(record.value.digestSha256);
    if (view === undefined || !view.digestVerified)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `the stored bytes of ${record.value.originalFilename} no longer match its digest`);
    const pages = view.pageTexts ?? (view.text !== undefined ? [view.text] : undefined);
    if (pages === undefined || pages.every((p) => p.trim() === ''))
      throw new XoError(
        ErrorCode.PRECONDITION_FAILED,
        `${record.value.originalFilename} has no text to read (compile it to recover scanned pages)`,
      );
    const settings = await new FsSettingsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId).get();
    const choice = usableModelChoices(settings, providerFor)[0]!;
    const provider = providerFor(choice.provider)!;
    let derived;
    try {
      derived = await deriveClaimsFromText({
        model: provider,
        modelName: choice.model,
        tenantId: workspace.workspaceId,
        source: { digestSha256: record.value.digestSha256, name: record.value.originalFilename },
        pages,
        recordedAt: new Date().toISOString(),
      });
    } catch (e) {
      if (e instanceof DerivationRefused) throw new XoError(ErrorCode.PRECONDITION_FAILED, `${e.code}: ${e.message}`);
      throw e;
    }
    const actor = requirePrincipal(req);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const changeSet =
      derived.claims.length === 0
        ? undefined
        : await kb.propose({
            operations: derived.claims.map((r) => ({ op: 'add' as const, record: r })),
            origin: { kind: 'model-derivation', ref: sourceId },
            proposedBy: { id: actor.id, kind: actor.kind },
          });
    if (changeSet !== undefined)
      await audit.tryRecord({
        action: 'knowledge.derive',
        actor: actorFromPrincipal(actor),
        correlationId,
        target: { kind: 'knowledge-change-set', id: changeSet.changeSetId, workspaceId: workspace.workspaceId },
        type: 'knowledge.change-set.proposed',
        outcome: 'completed',
        metadata: { sourceId: safeId(sourceId) ?? 'unknown', operations: changeSet.operations.length, refused: derived.refused.length },
      });
    return json(changeSet === undefined ? 200 : 201, {
      changeSet: changeSet ?? null,
      proposed: derived.claims.length,
      refused: derived.refused,
      model: { provider: choice.provider, model: choice.model },
    });
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
    if (kind === 'approve' && dataConfig.preExecution?.approvalSeparation === 'required') {
      // UW-11a (ADR 0050 decision 5): knowledge from people's work (a rollback, a run outcome) is not approved by its proposer.
      const cs = await kb.changeSet(changeSetId);
      if ((cs.origin.kind === 'rollback' || cs.origin.kind === 'run-outcome') && cs.proposedBy.id === actor.id) {
        await audit.tryRecord({ ...draft, type: 'knowledge.change-set.denied', outcome: 'denied', reasonCode: 'separation_of_duties' });
        throw new XoError(ErrorCode.KNOWLEDGE_APPROVAL_REFUSED, 'a change set cannot be approved by the person who proposed it', {
          context: { reason: 'separation_of_duties' },
        });
      }
    }
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

  /** UW-11a: what approving a change set would do, and which certified workflows it affects. Nothing is stored. */
  async function previewChangeSet(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const preview = await kb.previewApproval(req.params['changeSetId'] ?? '');
    return json(200, { preview, affected: await affectedCertificates(workspace, dataConfig, kb, preview.nextState) });
  }

  /** UW-11a: proposes a rollback to an ancestor state (author role). Approval is a separate, reviewed step. */
  async function proposeRollback(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'knowledge.rollback', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'propose a knowledge rollback' });
    const body = await req.json<{ toStateId?: unknown; reason?: unknown }>();
    if (!body.ok) throw body.error;
    const { toStateId, reason } = body.value;
    if (typeof toStateId !== 'string' || !/^ks_[0-9a-f]{24}$/.test(toStateId))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'toStateId must be a knowledge state id');
    if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 500)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason must be 1 to 500 characters');
    const actor = requirePrincipal(req);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const changeSet = await kb.proposeRollback(
      toStateId,
      { id: actor.id, kind: actor.kind },
      reason,
      await affectedWarning(workspace, dataConfig, kb, [], { kind: 'rollback', ref: toStateId }),
    );
    await audit.tryRecord({
      action: 'knowledge.rollback',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'knowledge-change-set', id: changeSet.changeSetId, workspaceId: workspace.workspaceId },
      type: 'knowledge.change-set.proposed',
      outcome: 'completed',
      metadata: { origin: 'rollback', operations: changeSet.operations.length },
    });
    return json(201, { changeSet });
  }

  /** UW-11a: the knowledge states, newest first, from the head back through their parents. */
  async function listStates(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const size = Math.min(200, Math.max(1, Number(req.query.get('size') ?? '50') || 50));
    const page = Math.max(0, Number(req.query.get('page') ?? '0') || 0);
    const all: { stateId: string; parentStateId: string | null; changeSetId: string | null; createdAt: string }[] = [];
    let cursor: KnowledgeState | undefined = await kb.head();
    while (cursor !== undefined) {
      all.push({
        stateId: cursor.stateId,
        parentStateId: cursor.parentStateId,
        changeSetId: cursor.changeSetId,
        createdAt: cursor.createdAt,
      });
      cursor = cursor.parentStateId === null ? undefined : await kb.state(cursor.parentStateId);
    }
    return json(200, { states: all.slice(page * size, page * size + size), total: all.length });
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
    // UW-4b: when the state is the head, the head pointer must agree with the event log and the state's content.
    const isHead = (await kb.head()).stateId === id;
    const head = isHead ? await kb.verifyHead() : [];
    return json(200, {
      stateId: id,
      verified: findings.length === 0 && head.length === 0,
      findings: [...findings, ...head],
      contentRoot: await kb.contentRoot(id),
    });
  }

  /**
   * UW-4a (UAC-12): which records of a state may feed execution, and why the others may not. `records` (comma-separated) names
   * the records to check; without it, every record of the state is checked.
   */
  async function executable(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const kb = await workspaceKnowledgeBase(workspace, dataConfig);
    const stateId = req.params['stateId'] ?? '';
    const ids = req.query.get('records');
    const result = await executableKnowledge(kb, stateId, new WorkspaceEvidenceSources(workspaceSourcesStore(workspace, dataConfig)), {
      ...(ids !== null && ids.trim() !== ''
        ? {
            recordIds: ids
              .split(',')
              .map((x) => x.trim())
              .filter((x) => x !== ''),
          }
        : {}),
    });
    return json(200, result);
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
    // UW-4c: approved knowledge only, unless the caller names lifecycles (`lifecycle=active,needs_review` or `any`).
    const lc = req.query.get('lifecycle');
    const LIFECYCLES = ['proposed', 'needs_review', 'active', 'rejected', 'superseded', 'expired'] as const;
    let lifecycle: readonly (typeof LIFECYCLES)[number][] | 'any' | undefined;
    if (lc === 'any') lifecycle = 'any';
    else if (lc !== null) {
      const parts = lc.split(',').map((x) => x.trim());
      const bad = parts.filter((x) => !(LIFECYCLES as readonly string[]).includes(x));
      if (bad.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `lifecycle must be any, or a list of ${LIFECYCLES.join(', ')}`);
      lifecycle = parts as (typeof LIFECYCLES)[number][];
    }
    return json(200, { stateId, hits: await kb.search(stateId, q, limit, lifecycle !== undefined ? { lifecycle } : {}) });
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
  router.post('/workspaces/:workspaceId/sources/:sourceId/knowledge-derivations', guarded(deriveFromSource));
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
  router.get('/workspaces/:workspaceId/knowledge/change-sets/:changeSetId/preview', guarded(previewChangeSet));
  router.post('/workspaces/:workspaceId/knowledge/rollbacks', guarded(proposeRollback));
  router.get('/workspaces/:workspaceId/knowledge/states', guarded(listStates));
  router.get('/workspaces/:workspaceId/knowledge/state', guarded(getState));
  router.get('/workspaces/:workspaceId/knowledge/states/:stateId', guarded(getState));
  router.get('/workspaces/:workspaceId/knowledge/states/:stateId/verify', guarded(verifyState));
  router.get('/workspaces/:workspaceId/knowledge/states/:stateId/executable', guarded(executable));
  router.get('/workspaces/:workspaceId/knowledge/records', guarded(listRecords));
  router.get('/workspaces/:workspaceId/knowledge/search', guarded(search));
  router.get('/workspaces/:workspaceId/knowledge/resolve-entity', guarded(resolveEntity));
  router.get('/workspaces/:workspaceId/knowledge/conflicts', guarded(listConflicts));
  router.get('/workspaces/:workspaceId/knowledge/packs', guarded(listPacks));
  router.post('/workspaces/:workspaceId/knowledge/packs', guarded(installPack));
}
