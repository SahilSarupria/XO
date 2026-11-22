import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { SYSTEM_ACTOR, actorFromPrincipal } from '@xo/audit';
import { ConnectorError, ConnectorHost, CredentialError, MapVault, type Connector, type Json } from '@xo/connectors';
import type { AdapterCredential } from '@xo/adapters';
import { loadCredentialsConfig, workspaceBroker } from '../credentials/credentials.js';
import {
  LeaseAuthority,
  LeasedRunStore,
  effectsOf,
  LeaseError,
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  ApprovalError,
  RunInputError,
  signDecision,
  type RunResult,
} from '@xo/workflow-runtime';
import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import type { ExternalToolAdapter } from '@xo/adapters';
import type { WorkflowComponent } from '@xo/workflow-ir';
import { join } from 'node:path';
import { requireRecentAuthentication } from '../auth/step-up.js';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { requireOwnedWorkspace, requirePermission, requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';
import type { AuditService } from '../audit/audit-service.js';
import { auditedOwnedWorkspace, newCorrelationId, safeId } from '../audit/audit-service.js';
import { workspaceDefinitionsStore, type WorkflowDefinitionRecord } from './pre-execution-routes.js';
import { verifyCertificateNow, workspaceCertificatesStore } from './readiness-routes.js';
import { readConnectorBindings, writeConnectorBindings, parseConnectorBindings } from '../pre-execution/connector-bindings.js';
import { approvalKeyring, currentPublicKeys, verifyJournaledDecision } from '../pre-execution/approval-keys.js';
import { effectAuthorizer, type EffectCall } from '../pre-execution/effect-authorization.js';
import { FsControlsStore } from '../workflow-controls/fs-controls-store.js';
import { enforceNotPaused } from '../workflow-controls/service.js';
import { exceptionReport } from '../workflow-controls/exceptions.js';
import { checkDataDrift, driftSummary } from '../drift/data-drift.js';
import { adapterFor, installedAdapterIds, workspaceStateStore } from '../workspace/workspace-context.js';
import { workspaceWorkflowEntitiesStore } from '../workflow-entities/entity-store.js';

/**
 * ADR 0030 — generated workflows run as Workflow IR, interpreted by `@xo/workflow-runtime`: the definition the readiness
 * certificate binds is the definition that runs. Every start presents a current READY certificate for that exact generated
 * workflow (re-verified now, whatever the workspace setting). Human steps wait for a person; the platform signs each
 * decision on behalf of the authenticated reviewer (review role, recent sign-in), so the run's journal records who decided.
 * Connector steps go through `ConnectorHost` to the adapters the host installed for the workspace's bindings; an unknown
 * outcome is never retried silently, it escalates.
 *
 * Runs are journaled per generated workflow under `<data>/<workspace>/generated-runs/<definitionId>/` (hash-chained,
 * restart-safe). ADR 0031:
 *   - every connector call is authorized again at the moment it is made (`effect-authorization.ts`), not only at start;
 *   - decisions are signed with the instance's durable, governed key (`approval-keys.ts`), so pending approvals and past
 *     decisions survive restarts and verify on every instance;
 *   - every write to a run holds that run's lease (fencing tokens, arbitrated across processes by a lock file), so two API
 *     instances never drive the same run: timers and approval timeouts are advanced by whichever instance holds it.
 */

/** This process, as a lease owner. */
const INSTANCE = `api-${hostname()
  .replace(/[^A-Za-z0-9_.-]/g, '_')
  .slice(0, 40)}-${process.pid}-${randomBytes(3).toString('hex')}`;
const LEASE_TTL_MS = 60_000;

export const runsDir = (dataConfig: WorkspaceDataConfig, workspaceId: string, definitionId: string): string =>
  join(dataConfig.dataRootDir, workspaceId, 'generated-runs', definitionId);

export interface RunMeta {
  readonly initiator: EffectCall['initiator'];
  readonly certificateId: string;
  readonly startedAt: string;
  /** UW-2 (ADR 0032): the Workflow entity and version this run belongs to, recorded before the run's first entry. */
  readonly workflow?: { readonly workflowId: string; readonly version: number };
}

export async function readMeta(dir: string, runId: string): Promise<RunMeta | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, 'meta', `${runId}.json`), 'utf8')) as RunMeta;
  } catch {
    return undefined;
  }
}

/** For an item run of a `for_each`, the run that fanned it out (whose initiator it acts for). */
async function rootRunId(store: RunStore, runId: string): Promise<string> {
  let id = runId;
  for (let depth = 0; depth < 4; depth++) {
    const first = (await store.read(id).catch(() => []))[0];
    const parent = first?.type === 'run_started' ? (first.data as { parent?: unknown }).parent : undefined;
    if (typeof parent !== 'string') return id;
    id = parent;
  }
  return id;
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      if (cause instanceof RunInputError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { problems: [...cause.problems] } }));
      if (cause instanceof ApprovalError)
        return errorToResponse(new XoError(ErrorCode.INVALID_ARGUMENT, cause.message, { context: { reason: cause.code } }));
      return errorToResponse(cause);
    }
  };
}

/** Asks, immediately before each call, whether it may still be made; a refusal is `DENIED` and nothing is sent. */
export type EffectGate = (call: {
  readonly runId: string;
  readonly stepId: string;
  readonly connector: string;
  readonly operation: string;
}) => Promise<string | undefined>;

export function bridge(
  adapter: ExternalToolAdapter,
  connectorId: string,
  operations: Readonly<Record<string, 'read' | 'write' | 'irreversible'>>,
  gate: EffectGate,
  /** UW-9: the binding's connection credential, offered to the adapter per call (never the secret itself). */
  credential?: (operation: string) => AdapterCredential,
): Connector {
  const ops: Record<string, Connector['operations'][string]> = {};
  for (const [name, sideEffect] of Object.entries(operations))
    ops[name] = {
      sideEffect,
      execute: async (args, ctx) => {
        const refused = await gate({ runId: ctx.runId, stepId: ctx.stepId, connector: connectorId, operation: name });
        if (refused !== undefined) throw new ConnectorError('DENIED', `not authorized now: ${refused}`, 'none');
        const r = await adapter.invoke({
          capabilityId: `${connectorId}.${name}`,
          dispatchKey: ctx.idempotencyKey ?? `${ctx.runId}:${ctx.stepId}`,
          input: args,
          ...(credential !== undefined ? { credential: credential(name) } : {}),
        });
        if (r.kind === 'confirmed_success') return (r.output ?? null) as Json;
        if (r.kind === 'confirmed_failure_no_effect') throw new ConnectorError('FAILED', `${r.code}: ${r.message}`, 'none');
        throw new ConnectorError('FAILED', `outcome unknown: ${r.reason}`);
      },
    };
  return { kind: 'http', operations: ops };
}

export interface RunnerDeps {
  readonly workspaceStore: WorkspaceStore;
  readonly dataConfig: WorkspaceDataConfig;
  readonly permissionManager: PermissionManager;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly audit?: AuditService;
  /** The lease owner (default: this process). Tests use two to stand for two instances. */
  readonly owner?: string;
}

/**
 * The runner for one generated workflow, with its connectors, its leases and (for a decision) the deciding reviewer.
 * `starting` names who is starting a run in this request: the effects of a run are authorized for the person who started
 * it, read from the run's record afterwards.
 */
export async function runnerFor(
  deps: RunnerDeps,
  workspace: WorkspaceRecord,
  definition: WorkflowDefinitionRecord,
  options: { readonly reviewer?: { readonly id: string }; readonly starting?: { readonly runId: string; readonly meta: RunMeta } } = {},
): Promise<WorkflowRunner> {
  const { dataConfig } = deps;
  const reviewer = options.reviewer;
  const component = definition.lowered.component as WorkflowComponent | undefined;
  if (component === undefined)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `generated workflow ${definition.definitionId} has no definition to run`);
  const bindings = (await readConnectorBindings(workspace, dataConfig)).bindings;
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const authorizer = effectAuthorizer({
    workspaceStore: deps.workspaceStore,
    dataConfig,
    permissionManager: deps.permissionManager,
    workspaceId: workspace.workspaceId,
    definition,
  });
  const authority = new LeaseAuthority(join(dir, 'leases'), store, Date.now, { crossProcess: {} });
  const leased = new LeasedRunStore(authority, store);
  // One lease owner per runner: two requests in one process exclude each other exactly as two processes do.
  const owner = `${deps.owner ?? INSTANCE}-${randomBytes(4).toString('hex')}`;
  const keys = await approvalKeyring(dataConfig.dataRootDir, deps.env);
  const implementations: Record<string, Connector> = {};
  const grants: Record<string, { grant: string[] }> = {};
  for (const decl of component.connectors) {
    const b = bindings.find((x) => x.connector === decl.id);
    const adapter = b !== undefined ? adapterFor(dataConfig, workspace, b.adapter) : undefined;
    if (adapter === undefined) continue; // undeclared implementation: the host refuses the call (NO_IMPLEMENTATION), it never guesses
    const ops = Object.fromEntries(decl.operations.map((o) => [o.name, o.sideEffect]));
    const adapterId = b!.adapter;
    const gate: EffectGate = async (call) => {
      const root = await rootRunId(store, call.runId);
      const meta = options.starting?.runId === root ? options.starting.meta : await readMeta(dir, root);
      const reason =
        meta === undefined
          ? 'the run has no record of who started it'
          : await authorizer.check({
              stepId: call.stepId,
              connector: call.connector,
              operation: call.operation,
              adapterId,
              initiator: meta.initiator,
            });
      if (reason !== undefined)
        await deps.audit?.tryRecord({
          action: 'generated-workflow.effect',
          actor: SYSTEM_ACTOR,
          correlationId: `${call.runId}:${call.stepId}`,
          target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
          type: 'generated-workflow.effect.denied',
          outcome: 'denied',
          reasonCode: 'effect_not_authorized',
          metadata: {
            runId: call.runId,
            step: call.stepId,
            connector: call.connector,
            operation: call.operation,
            reason: reason.slice(0, 300),
          },
        });
      return reason;
    };
    // UW-9: a binding that names a connection credential lends it to the adapter for each call, through the broker: this
    // workspace's credential, active, with the scopes the adapter asks for, refreshed when due. A refusal stops the call before
    // anything is sent.
    const credentialId = b!.credentialId;
    const lend =
      credentialId === undefined
        ? undefined
        : (operation: string): AdapterCredential => ({
            use: async (fn, need) => {
              const config = await (dataConfig.credentials ?? (() => loadCredentialsConfig(dataConfig.dataRootDir, deps.env)))();
              if (config === undefined)
                throw new ConnectorError('DENIED', 'connections are not configured on this instance (XO_CREDENTIALS_KEY)', 'none');
              try {
                return await workspaceBroker(workspace, dataConfig.dataRootDir, config, deps.audit).use(
                  credentialId,
                  { ...(need?.scopes !== undefined ? { scopes: need.scopes } : {}), purpose: `connector:${decl.id}.${operation}` },
                  fn,
                );
              } catch (e) {
                if (e instanceof CredentialError) throw new ConnectorError('DENIED', `the connection cannot be used: ${e.message}`, 'none');
                throw e;
              }
            },
          });
    implementations[decl.id] = { ...bridge(adapter, decl.id, ops, gate, lend), kind: decl.kind };
    grants[decl.id] = { grant: decl.operations.map((o) => o.name) };
  }
  return new WorkflowRunner({
    component,
    workflowId: component.workflows[0]!.id,
    store: leased,
    lease: {
      client: authority,
      owner,
      ttlMs: LEASE_TTL_MS,
      attach: (id, token) => leased.attach(id, owner, token),
      detach: (id) => leased.detach(id),
    },
    connectors: new ConnectorHost({ component, policy: { connectors: grants }, implementations, vault: new MapVault({}) }),
    approvals: {
      reviewers: new StaticReviewerRegistry(
        reviewer !== undefined ? [{ id: reviewer.id, roles: ['reviewer'], publicKeyPem: keys.active.publicKeyPem }] : [],
      ),
    },
  });
}

export async function view(runner: WorkflowRunner, runId: string, dir: string, dataRootDir: string): Promise<Record<string, unknown>> {
  // A due timer or an expired approval on THIS run advances now (under its lease); another instance holding it is fine.
  const before = await runner.status(runId);
  if (before.state === 'waiting')
    await runner.resume(runId).catch((e: unknown) => (e instanceof LeaseError ? undefined : Promise.reject(e)));
  const status = await runner.status(runId);
  const pending = (await runner.listApprovals()).filter((a) => a.runId === runId);
  // Every journaled decision is re-verified against the keyring: which key signed it, or that none does.
  const keys = await currentPublicKeys(dataRootDir);
  const entries = await new RunStore(dir).read(runId);
  const decisions = entries
    .filter((e) => e.type === 'approval_decided')
    .map((e) => {
      const d = e.data as { step: string; reviewerId: string; action: string; payload: Record<string, unknown>; signature: string };
      const keyId = verifyJournaledDecision(d.payload, d.signature, keys);
      return {
        step: d.step,
        reviewerId: d.reviewerId,
        action: d.action,
        at: d.payload['at'],
        signatureVerified: keyId !== undefined,
        ...(keyId !== undefined ? { keyId } : {}),
      };
    });
  const meta = await readMeta(dir, runId);
  return {
    ...status,
    pendingApprovals: pending,
    decisions,
    // UW-7 (ADR 0033, UAC-9): every external call of this run in the one effect vocabulary.
    effects: effectsOf(entries),
    ...(meta !== undefined ? { startedBy: meta.initiator.id, startedAt: meta.startedAt } : {}),
    ...(meta?.workflow !== undefined ? { workflow: meta.workflow } : {}),
  };
}

/** UW-2: a run that belongs to a Workflow entity tells the workspace change feed that it moved. */
async function publishRunChange(
  dataConfig: WorkspaceDataConfig,
  workspaceId: string,
  meta: RunMeta | undefined,
  runId: string,
  state: string,
): Promise<void> {
  if (meta?.workflow === undefined) return;
  await workspaceWorkflowEntitiesStore(dataConfig.dataRootDir, workspaceId).publish({
    at: new Date().toISOString(),
    workflowId: meta.workflow.workflowId,
    kind: 'run',
    runId,
    state,
  });
}

export interface StartGeneratedRun {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly input: Record<string, unknown>;
  readonly certificateId: unknown;
  readonly idempotencyKey?: unknown;
  readonly correlationId: string;
  readonly workflow?: { readonly workflowId: string; readonly version: number };
}

/**
 * Starts a generated workflow as Workflow IR: the certificate gate, the workspace pause, the run id, the durable record of who
 * started it (and, for a Workflow entity, which workflow and version) before the first journal entry, then the run. Shared by
 * the generated-workflow route and the Workflow entity route, so both enforce exactly the same gates.
 */
export async function startGeneratedRun(
  deps: RunnerDeps,
  s: StartGeneratedRun,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const { workspace, actor, definition, audit } = { ...s, audit: deps.audit };
  const { dataConfig } = deps;
  const draft = {
    action: 'generated-workflow.run',
    actor: actorFromPrincipal(actor),
    correlationId: s.correlationId,
    target: { kind: 'workflow' as const, id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
  };
  const certificateId = s.certificateId;
  if (typeof certificateId !== 'string') {
    await audit?.tryRecord({ ...draft, type: 'readiness.start.refused', outcome: 'denied', reasonCode: 'certificate_required' });
    throw new XoError(
      ErrorCode.READINESS_CERTIFICATE_REQUIRED,
      'a generated workflow runs only with a current readiness certificate: request one and pass its certificateId',
    );
  }
  const cert = await workspaceCertificatesStore(workspace, dataConfig).get(certificateId);
  const reasons: string[] = [];
  if (cert.scope.definitionId !== definition.definitionId) reasons.push(`certificate ${certificateId} is for another generated workflow`);
  else {
    const v = await verifyCertificateNow(workspace, dataConfig, cert);
    if (!v.ok) reasons.push(...v.reasons);
  }
  if (reasons.length > 0) {
    await audit?.tryRecord({
      ...draft,
      type: 'readiness.start.refused',
      outcome: 'denied',
      reasonCode: 'certificate_refused',
      metadata: { certificateId },
    });
    throw new XoError(
      ErrorCode.READINESS_CERTIFICATE_REFUSED,
      `the readiness certificate does not allow this start: ${reasons.join('; ')}`,
      { context: { certificateId, reasons } },
    );
  }
  await enforceNotPaused(new FsControlsStore(workspaceStateStore(workspace, dataConfig), workspace.workspaceId));
  // UW-15 (UAC-34): the data must still have the shape this workflow was compiled for. A used column renamed, removed or retyped, or
  // reformatted, stops the run HERE, before a run record or any effect exists, with the differences in the error.
  const drift = await checkDataDrift(workspace, dataConfig, definition.compilationId, definition.dataReads ?? []);
  if (drift.status === 'blocking') {
    await audit?.tryRecord({
      ...draft,
      type: 'generated-workflow.drift.refused',
      outcome: 'denied',
      reasonCode: 'data_schema_drift',
      metadata: {
        sources: drift.sources.filter((x) => x.status === 'blocking').length,
        differences: drift.sources.reduce(
          (n, x) => n + x.tables.reduce((m, t) => m + t.report.differences.filter((d) => d.severity === 'blocking').length, 0),
          0,
        ),
      },
    });
    throw new XoError(ErrorCode.DATA_SCHEMA_DRIFT, driftSummary(drift), { context: { report: drift } });
  }
  const idem = s.idempotencyKey;
  // The run id is fixed before the run starts, so who started it is on record before its first effect. A run started for a
  // Workflow entity also binds the entity into the id, so one key on two workflows that share a definition are two runs.
  const scope = s.workflow !== undefined ? `\u0000${s.workflow.workflowId}` : '';
  const runId =
    typeof idem === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(idem)
      ? `run_${createHash('sha256').update(`${definition.definitionId}\u0000${actor.id}\u0000${idem}${scope}`).digest('hex').slice(0, 32)}`
      : `run_${randomBytes(16).toString('hex')}`;
  const meta: RunMeta = {
    initiator: { kind: actor.kind, id: actor.id },
    certificateId,
    startedAt: new Date().toISOString(),
    ...(s.workflow !== undefined ? { workflow: { workflowId: s.workflow.workflowId, version: s.workflow.version } } : {}),
  };
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  await mkdir(join(dir, 'meta'), { recursive: true });
  await writeFile(join(dir, 'meta', `${runId}.json`), JSON.stringify(meta), { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') throw e; // a retry of the same request: the first record stands
  });
  const stored = (await readMeta(dir, runId)) ?? meta;
  if (s.workflow !== undefined && stored.workflow?.workflowId !== s.workflow.workflowId)
    throw new XoError(ErrorCode.ALREADY_EXISTS, `run ${runId} already exists for another workflow; use another Idempotency-Key`);
  const runner = await runnerFor(deps, workspace, definition, { starting: { runId, meta: stored } });
  const result: RunResult = await runner.start({ inputs: s.input, runId });
  await audit?.tryRecord({
    ...draft,
    type: 'generated-workflow.run.started',
    outcome: 'completed',
    metadata: {
      runId: result.runId,
      certificateId,
      state: result.state,
      ...(stored.workflow !== undefined ? { workflowEntityId: stored.workflow.workflowId, workflowVersion: stored.workflow.version } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, stored, result.runId, result.state);
  return {
    status: result.accepted ? 201 : 200,
    body: { ...(await view(runner, result.runId, dir, dataConfig.dataRootDir)), certificateId },
  };
}

const RUN_REF = /^(run|fe)_[0-9a-f]{32,40}$/;

/**
 * How an audit event names a run. An item of a batch (`fe_` + 40 hex) is named by its batch's run id and its index: the audit
 * refuses long opaque values in metadata, and the pair is what a person needs to find it.
 */
async function auditRunRef(store: RunStore, runId: string): Promise<Record<string, string | number>> {
  if (!runId.startsWith('fe_')) return { runId };
  const first = (await store.read(runId).catch(() => []))[0];
  const d = (first?.data ?? {}) as { parent?: unknown; index?: unknown };
  return typeof d.parent === 'string' && typeof d.index === 'number' ? { runId: d.parent, item: d.index } : {};
}

export interface CancelGeneratedRun {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly reason: unknown;
  readonly correlationId: string;
  /** For the entity route: the run must belong to this workflow. */
  readonly workflowId?: string;
}

/**
 * ADR 0024 — cancels a run or a whole batch (or one item of a batch). The request is recorded durably before anything else; no
 * dispatch starts after it; work already settled stands; a call in flight becomes an unknown outcome for a person; a repeat changes
 * nothing. When another instance is driving the run, it applies the request before its next step or call (`applied: false` here).
 * Audited every time, a repeat included.
 */
export async function cancelGeneratedRun(deps: RunnerDeps, c: CancelGeneratedRun): Promise<Record<string, unknown>> {
  const { workspace, actor, definition, runId } = c;
  const { dataConfig } = deps;
  if (!RUN_REF.test(runId)) throw new NotFoundError(`run "${runId}"`);
  if (c.reason !== undefined && (typeof c.reason !== 'string' || c.reason.length > 500))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason must be a string of at most 500 characters');
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const root = await rootRunId(store, runId);
  const meta = await readMeta(dir, root);
  if ((await store.read(runId).catch(() => [])).length === 0) throw new NotFoundError(`run "${runId}"`);
  if (c.workflowId !== undefined && meta?.workflow?.workflowId !== c.workflowId)
    throw new NotFoundError(`run "${runId}" of workflow "${c.workflowId}"`);
  const runner = await runnerFor(deps, workspace, definition);
  const result = await runner.cancel(runId, {
    by: actor.id,
    ...(typeof c.reason === 'string' && c.reason.trim() !== '' ? { reason: c.reason.trim() } : {}),
  });
  await deps.audit?.tryRecord({
    action: 'generated-workflow.cancel',
    actor: actorFromPrincipal(actor),
    correlationId: c.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.run.cancelled',
    outcome: 'completed',
    metadata: {
      ...(await auditRunRef(store, runId)),
      state: result.state,
      recorded: result.recorded,
      applied: result.cancellation?.applied === true,
      ...(meta?.workflow !== undefined ? { workflowEntityId: meta.workflow.workflowId } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, meta, runId, result.state);
  return { ...(await view(runner, runId, dir, dataConfig.dataRootDir)), cancelRecorded: result.recorded };
}

export interface ReconcileGeneratedEffect {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly step: string;
  readonly decision: unknown;
  readonly reason: unknown;
  readonly evidenceExamined: unknown;
  readonly correlationId: string;
  readonly workflowId?: string;
}

/**
 * A person records what happened to a call whose outcome is unknown (UAC-8). Nothing is sent, re-sent or undone. Callers check
 * the review role and a recent sign-in first.
 */
export async function reconcileGeneratedEffect(deps: RunnerDeps, r: ReconcileGeneratedEffect): Promise<Record<string, unknown>> {
  const { workspace, actor, definition, runId, step } = r;
  const { dataConfig } = deps;
  if (!RUN_REF.test(runId)) throw new NotFoundError(`run "${runId}"`);
  const decision = r.decision;
  if (decision !== 'confirmed_success' && decision !== 'confirmed_failure_no_effect' && decision !== 'unresolved')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'decision must be confirmed_success, confirmed_failure_no_effect or unresolved');
  if (typeof r.reason !== 'string' || r.reason.trim().length === 0 || r.reason.length > 1000)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'reason (what you checked and found) is required, at most 1000 characters');
  if (r.evidenceExamined !== undefined && (typeof r.evidenceExamined !== 'string' || r.evidenceExamined.length > 1000))
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'evidenceExamined must be a string of at most 1000 characters');
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const store = new RunStore(dir);
  const entries = await store.read(runId).catch(() => []);
  if (entries.length === 0) throw new NotFoundError(`run "${runId}"`);
  const meta = await readMeta(dir, await rootRunId(store, runId));
  if (r.workflowId !== undefined && meta?.workflow?.workflowId !== r.workflowId)
    throw new NotFoundError(`run "${runId}" of workflow "${r.workflowId}"`);
  const current = effectsOf(entries).find((e) => e.step === step);
  if (current === undefined) throw new NotFoundError(`an external call of step "${step}" on run "${runId}"`);
  if (current.state !== 'outcome_unknown' && current.state !== 'reconciliation_required')
    throw new XoError(
      ErrorCode.PRECONDITION_FAILED,
      `the call of step "${step}" is ${current.state}; only an unknown outcome is reconciled`,
      {
        context: { state: current.state },
      },
    );
  const runner = await runnerFor(deps, workspace, definition);
  const effect = await runner.recordReconciliation(runId, step, {
    decision,
    by: actor.id,
    reason: r.reason.trim(),
    ...(typeof r.evidenceExamined === 'string' ? { evidenceExamined: r.evidenceExamined } : {}),
  });
  await deps.audit?.tryRecord({
    action: 'generated-workflow.reconcile',
    actor: actorFromPrincipal(actor),
    correlationId: r.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.effect.reconciled',
    outcome: 'completed',
    metadata: {
      ...(await auditRunRef(store, runId)),
      step,
      decision,
      state: effect.state,
      ...(meta?.workflow !== undefined ? { workflowEntityId: meta.workflow.workflowId } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, meta, runId, effect.state);
  return { runId, effect };
}

export interface DecideGeneratedApproval {
  readonly workspace: WorkspaceRecord;
  readonly actor: AuthenticatedPrincipal;
  readonly definition: WorkflowDefinitionRecord;
  readonly runId: string;
  readonly approvalId: string;
  readonly action: unknown;
  readonly comment: unknown;
  readonly correlationId: string;
  /** For the entity route: the decision must be on a run of this workflow. */
  readonly workflowId?: string;
}

/** A person decides a human step; the platform signs the decision as theirs. Callers check role and recent sign-in first. */
export async function decideGeneratedApproval(deps: RunnerDeps, d: DecideGeneratedApproval): Promise<Record<string, unknown>> {
  const { workspace, actor, definition, runId, approvalId } = d;
  const { dataConfig } = deps;
  const action = d.action;
  if (action !== 'approve' && action !== 'reject')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'action must be "approve" (done as instructed) or "reject"');
  const comment = typeof d.comment === 'string' ? d.comment.slice(0, 2000) : undefined;
  const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
  const meta = await readMeta(dir, runId);
  if (d.workflowId !== undefined && meta?.workflow?.workflowId !== d.workflowId)
    throw new NotFoundError(`run "${runId}" of workflow "${d.workflowId}"`);
  const runner = await runnerFor(deps, workspace, definition, { reviewer: { id: actor.id } });
  const keys = await approvalKeyring(dataConfig.dataRootDir, deps.env);
  const request = (await runner.listApprovals()).find((a) => a.runId === runId && a.approvalId === approvalId);
  if (request === undefined) throw new NotFoundError(`pending approval "${approvalId}" on run "${runId}"`);
  const signed = signDecision(keys.active.privateKeyPem, {
    v: 1,
    approvalId,
    runId,
    step: request.step,
    action,
    edits: {},
    reviewerId: actor.id,
    at: new Date().toISOString(),
    ...(comment !== undefined ? { comment } : {}),
  });
  // The run may be busy for a moment (a timer firing, another decision): wait for its lease rather than fail.
  let result: RunResult | undefined;
  for (let attempt = 0; result === undefined; attempt++) {
    try {
      result = await runner.decideApproval(runId, signed);
    } catch (e) {
      if (!(e instanceof LeaseError && e.code === 'HELD') || attempt >= 50) throw e;
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  await deps.audit?.tryRecord({
    action: 'generated-workflow.decide',
    actor: actorFromPrincipal(actor),
    correlationId: d.correlationId,
    target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    type: 'generated-workflow.approval.decided',
    outcome: 'completed',
    metadata: {
      // An item of a batch is named by its batch and index (the audit refuses long opaque values).
      ...(await auditRunRef(new RunStore(dir), runId)),
      step: request.step,
      action,
      state: result.state,
      ...(meta?.workflow !== undefined ? { workflowEntityId: meta.workflow.workflowId } : {}),
    },
  });
  await publishRunChange(dataConfig, workspace.workspaceId, meta, runId, result.state);
  return view(runner, runId, dir, dataConfig.dataRootDir);
}

export function registerGeneratedRunRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  audit: AuditService,
  permissionManager: PermissionManager,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const auditCtx = { audit, workspaceStore };
  const deps: RunnerDeps = { workspaceStore, dataConfig, permissionManager, env, audit };

  async function getBindings(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const stored = await readConnectorBindings(workspace, dataConfig);
    const available = installedAdapterIds(dataConfig);
    return json(200, { ...stored, bindings: stored.bindings.map((b) => ({ ...b, adapterInstalled: available.has(b.adapter) })) });
  }

  /** Replaces the workspace's connector bindings (manage role, recent sign-in, revision-guarded, audited). */
  async function putBindings(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'connector-bindings.update', correlationId });
    await requirePermission(req, workspace, 'manage', dataConfig, { action: 'bind connectors' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'bind connectors');
    const body = await req.json<{ bindings?: unknown; expectedRevision?: unknown }>();
    if (!body.ok) throw body.error;
    const bindings = parseConnectorBindings(body.value.bindings);
    // UW-9: a binding may name only an active connection credential of THIS workspace.
    const named = [...new Set(bindings.flatMap((b) => (b.credentialId !== undefined ? [b.credentialId] : [])))];
    if (named.length > 0) {
      const config = await (dataConfig.credentials ?? (() => loadCredentialsConfig(dataConfig.dataRootDir, env)))();
      if (config === undefined)
        throw new XoError(ErrorCode.CREDENTIALS_NOT_CONFIGURED, 'connections are not configured on this instance: set XO_CREDENTIALS_KEY');
      const broker = workspaceBroker(workspace, dataConfig.dataRootDir, config);
      for (const id of named) {
        const c = await broker.describe(id).catch(() => undefined);
        if (c === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, `credential ${id} is not a connection of this workspace`);
        if (c.state !== 'active') throw new XoError(ErrorCode.CREDENTIAL_NOT_ACTIVE, `credential ${id} is ${c.state}; reconnect it first`);
      }
    }
    const current = await readConnectorBindings(workspace, dataConfig);
    if (body.value.expectedRevision !== undefined && body.value.expectedRevision !== current.revision)
      throw new XoError(ErrorCode.PRECONDITION_FAILED, `the bindings changed (revision ${current.revision}); reload and try again`);
    const actor = requirePrincipal(req);
    const next = { revision: current.revision + 1, bindings, updatedAt: new Date().toISOString(), updatedBy: actor.id };
    await writeConnectorBindings(workspace, dataConfig, next);
    await audit.tryRecord({
      action: 'connector-bindings.update',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workspace', id: workspace.workspaceId },
      type: 'connector-bindings.updated',
      outcome: 'completed',
      metadata: { revision: next.revision, bindings: bindings.length },
    });
    return json(200, next);
  }

  /** Starts a generated workflow as Workflow IR. A current READY (or READY_WITH_CONDITIONS) certificate is always required. */
  async function start(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.run', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'run a generated workflow' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ input?: unknown; certificateId?: unknown }>();
    if (!body.ok) throw body.error;
    const unknown = Object.keys(body.value).filter((k) => k !== 'input' && k !== 'certificateId');
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const input = body.value.input ?? {};
    if (typeof input !== 'object' || input === null || Array.isArray(input))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be an object');
    if (JSON.stringify(input).length > 1_048_576) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'input must be at most 1 MiB');
    const actor = requirePrincipal(req);
    const started = await startGeneratedRun(deps, {
      workspace,
      actor,
      definition,
      input: input as Record<string, unknown>,
      certificateId: body.value.certificateId,
      idempotencyKey: req.headers['idempotency-key'],
      correlationId,
    });
    return json(started.status, started.body);
  }

  async function status(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runner = await runnerFor(deps, workspace, definition);
    const runId = req.params['runId'] ?? '';
    try {
      return json(
        200,
        await view(runner, runId, runsDir(dataConfig, workspace.workspaceId, definition.definitionId), dataConfig.dataRootDir),
      );
    } catch {
      throw new NotFoundError(`run "${runId}"`);
    }
  }

  async function list(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const runner = await runnerFor(deps, workspace, definition);
    const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
    const store = new RunStore(dir);
    const runs = [];
    for (const id of await store.list().catch(() => [] as string[])) {
      const st = await runner.status(id).catch(() => undefined);
      if (st === undefined) continue;
      const meta = await readMeta(dir, id);
      runs.push({
        ...st,
        pendingApprovals: (await runner.listApprovals()).filter((a) => a.runId === id),
        ...(meta !== undefined ? { startedBy: meta.initiator.id } : {}),
      });
    }
    return json(200, { runs: runs.filter((r) => r !== undefined) });
  }

  /** UW-15 (UAC-36): how often this workflow needed a person over the last 30 days, and only the items still waiting for one. */
  async function exceptions(req: ApiRequest): Promise<ApiResponse> {
    const workspace = await requireOwnedWorkspace(req, workspaceStore);
    await requirePermission(req, workspace, 'read', dataConfig, { action: 'read workflow exceptions' });
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const store = new RunStore(runsDir(dataConfig, workspace.workspaceId, definition.definitionId));
    const runs = [];
    for (const id of await store.list().catch(() => [] as string[]))
      runs.push({ runId: id, entries: await store.read(id).catch(() => []) });
    return json(200, exceptionReport(runs, new Date()));
  }

  /** A person decides a human step: review role, recent sign-in; the platform signs the decision as theirs. */
  async function decide(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.decide', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'decide a human step' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'decide a human step');
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ action?: unknown; comment?: unknown }>();
    if (!body.ok) throw body.error;
    return json(
      200,
      await decideGeneratedApproval(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        runId: req.params['runId'] ?? '',
        approvalId: req.params['approvalId'] ?? '',
        action: body.value.action,
        comment: body.value.comment,
        correlationId,
      }),
    );
  }

  async function cancel(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.cancel', correlationId });
    await requirePermission(req, workspace, 'author', dataConfig, { action: 'cancel a workflow run' });
    const body = await req.json<Record<string, unknown>>();
    if (!body.ok) throw body.error;
    const b = body.value ?? {};
    const unknown = Object.keys(b).filter((k) => k !== 'reason');
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    return json(
      200,
      await cancelGeneratedRun(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        runId: req.params['runId'] ?? '',
        reason: b['reason'],
        correlationId,
      }),
    );
  }

  async function reconcileEffect(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.reconcile', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'record the outcome of an external call' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'record the outcome of an external call');
    const body = await req.json<Record<string, unknown>>();
    if (!body.ok) throw body.error;
    const b = body.value ?? {};
    const unknown = Object.keys(b).filter((k) => !['decision', 'reason', 'evidenceExamined'].includes(k));
    if (unknown.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field(s): ${unknown.join(', ')}`);
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    return json(
      200,
      await reconcileGeneratedEffect(deps, {
        workspace,
        actor: requirePrincipal(req),
        definition,
        runId: req.params['runId'] ?? '',
        step: req.params['step'] ?? '',
        decision: b['decision'],
        reason: b['reason'],
        evidenceExamined: b['evidenceExamined'],
        correlationId,
      }),
    );
  }

  // Due timers and approval deadlines advance even when nobody reads the run: every minute, each generated workflow with
  // runs is ticked (the interval never keeps the process alive).
  const tickAll = async (): Promise<void> => {
    const { readdir } = await import('node:fs/promises');
    for (const ws of await readdir(dataConfig.dataRootDir).catch(() => [] as string[])) {
      const runsDir = join(dataConfig.dataRootDir, ws, 'generated-runs');
      for (const definitionId of await readdir(runsDir).catch(() => [] as string[])) {
        try {
          const workspace = await workspaceStore.get(ws);
          if (!workspace.ok) continue;
          const definition = await workspaceDefinitionsStore(workspace.value, dataConfig).get(definitionId);
          const runner = await runnerFor(deps, workspace.value, definition);
          // UW-2: runs that belong to a Workflow entity report a timer- or deadline-driven move to the change feed.
          const dir = join(runsDir, definitionId);
          const linked = new Map<string, RunMeta>();
          for (const f of await readdir(join(dir, 'meta')).catch(() => [] as string[])) {
            const id = f.replace(/\.json$/, '');
            const meta = await readMeta(dir, id);
            if (meta?.workflow !== undefined) linked.set(id, meta);
          }
          const fingerprint = async (id: string): Promise<string> => {
            const st = await runner.status(id).catch(() => undefined);
            const pending = (await runner.listApprovals().catch(() => [])).filter((a) => a.runId === id).map((a) => a.approvalId);
            return `${st?.state ?? '?'}|${pending.sort().join(',')}`;
          };
          const before = new Map<string, string>();
          for (const id of [...linked.keys()]) {
            const f = await fingerprint(id);
            // Only runs still in progress can move on a tick.
            if (/^(created|running|waiting|compensating)\|/.test(f)) before.set(id, f);
            else linked.delete(id);
          }
          await runner.tick();
          for (const [id, meta] of linked) {
            const after = await fingerprint(id);
            if (after !== before.get(id)) await publishRunChange(dataConfig, ws, meta, id, after.split('|')[0] as string);
          }
        } catch {
          // one unreadable workflow never stops the others; its own status read reports the problem
        }
      }
    }
  };
  setInterval(() => void tickAll(), 60_000).unref();

  router.get('/workspaces/:workspaceId/connector-bindings', guarded(getBindings));
  router.put('/workspaces/:workspaceId/connector-bindings', guarded(putBindings));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs', guarded(start));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/exceptions', guarded(exceptions));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs', guarded(list));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId', guarded(status));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/approvals/:approvalId', guarded(decide));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/cancel', guarded(cancel));
  router.post(
    '/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/effects/:step/reconciliation',
    guarded(reconcileEffect),
  );
}
