import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { SYSTEM_ACTOR, actorFromPrincipal } from '@xo/audit';
import { ConnectorError, ConnectorHost, MapVault, type Connector, type Json } from '@xo/connectors';
import {
  LeaseAuthority,
  LeasedRunStore,
  LeaseError,
  RunStore,
  StaticReviewerRegistry,
  WorkflowRunner,
  ApprovalError,
  RunInputError,
  signDecision,
  type RunResult,
} from '@xo/workflow-runtime';
import type { PermissionManager } from '@xo/permissions';
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
import { workspaceStateStore } from '../workspace/workspace-context.js';

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

const runsDir = (dataConfig: WorkspaceDataConfig, workspaceId: string, definitionId: string): string =>
  join(dataConfig.dataRootDir, workspaceId, 'generated-runs', definitionId);

interface RunMeta {
  readonly initiator: EffectCall['initiator'];
  readonly certificateId: string;
  readonly startedAt: string;
}

async function readMeta(dir: string, runId: string): Promise<RunMeta | undefined> {
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
  const adapters = dataConfig.preExecution?.connectorAdapters ?? new Map<string, ExternalToolAdapter>();
  const implementations: Record<string, Connector> = {};
  const grants: Record<string, { grant: string[] }> = {};
  for (const decl of component.connectors) {
    const b = bindings.find((x) => x.connector === decl.id);
    const adapter = b !== undefined ? adapters.get(b.adapter) : undefined;
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
    implementations[decl.id] = { ...bridge(adapter, decl.id, ops, gate), kind: decl.kind };
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

async function view(runner: WorkflowRunner, runId: string, dir: string, dataRootDir: string): Promise<Record<string, unknown>> {
  // A due timer or an expired approval on THIS run advances now (under its lease); another instance holding it is fine.
  const before = await runner.status(runId);
  if (before.state === 'waiting')
    await runner.resume(runId).catch((e: unknown) => (e instanceof LeaseError ? undefined : Promise.reject(e)));
  const status = await runner.status(runId);
  const pending = (await runner.listApprovals()).filter((a) => a.runId === runId);
  // Every journaled decision is re-verified against the keyring: which key signed it, or that none does.
  const keys = await currentPublicKeys(dataRootDir);
  const decisions = (await new RunStore(dir).read(runId))
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
  return { ...status, pendingApprovals: pending, decisions, ...(meta !== undefined ? { startedBy: meta.initiator.id } : {}) };
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
    const available = new Set(dataConfig.preExecution?.connectorAdapters.keys() ?? []);
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
    const draft = {
      action: 'generated-workflow.run',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workflow' as const, id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
    };
    const certificateId = body.value.certificateId;
    if (typeof certificateId !== 'string') {
      await audit.tryRecord({ ...draft, type: 'readiness.start.refused', outcome: 'denied', reasonCode: 'certificate_required' });
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
      await audit.tryRecord({
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
    const idem = req.headers['idempotency-key'];
    // The run id is fixed before the run starts, so who started it is on record before its first effect.
    const runId =
      typeof idem === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(idem)
        ? `run_${createHash('sha256').update(`${definition.definitionId}\u0000${actor.id}\u0000${idem}`).digest('hex').slice(0, 32)}`
        : `run_${randomBytes(16).toString('hex')}`;
    const meta: RunMeta = { initiator: { kind: actor.kind, id: actor.id }, certificateId, startedAt: new Date().toISOString() };
    const dir = runsDir(dataConfig, workspace.workspaceId, definition.definitionId);
    await mkdir(join(dir, 'meta'), { recursive: true });
    await writeFile(join(dir, 'meta', `${runId}.json`), JSON.stringify(meta), { flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e; // a retry of the same request: the first record stands
    });
    const runner = await runnerFor(deps, workspace, definition, { starting: { runId, meta } });
    const result: RunResult = await runner.start({ inputs: input as Record<string, unknown>, runId });
    await audit.tryRecord({
      ...draft,
      type: 'generated-workflow.run.started',
      outcome: 'completed',
      metadata: { runId: result.runId, certificateId, state: result.state },
    });
    return json(result.accepted ? 201 : 200, { ...(await view(runner, result.runId, dir, dataConfig.dataRootDir)), certificateId });
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

  /** A person decides a human step: review role, recent sign-in; the platform signs the decision as theirs. */
  async function decide(req: ApiRequest): Promise<ApiResponse> {
    const correlationId = newCorrelationId();
    const workspace = await auditedOwnedWorkspace(req, auditCtx, { action: 'generated-workflow.decide', correlationId });
    await requirePermission(req, workspace, 'review', dataConfig, { action: 'decide a human step' });
    await requireRecentAuthentication(req, workspace, dataConfig, 'decide a human step');
    const definition = await workspaceDefinitionsStore(workspace, dataConfig).get(req.params['definitionId'] ?? '');
    const body = await req.json<{ action?: unknown; comment?: unknown }>();
    if (!body.ok) throw body.error;
    const action = body.value.action;
    if (action !== 'approve' && action !== 'reject')
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'action must be "approve" (done as instructed) or "reject"');
    const comment = typeof body.value.comment === 'string' ? body.value.comment.slice(0, 2000) : undefined;
    const actor = requirePrincipal(req);
    const runner = await runnerFor(deps, workspace, definition, { reviewer: { id: actor.id } });
    const keys = await approvalKeyring(dataConfig.dataRootDir, env);
    const runId = req.params['runId'] ?? '';
    const approvalId = req.params['approvalId'] ?? '';
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
    await audit.tryRecord({
      action: 'generated-workflow.decide',
      actor: actorFromPrincipal(actor),
      correlationId,
      target: { kind: 'workflow', id: safeId(definition.candidateWorkflowId) ?? 'workflow', workspaceId: workspace.workspaceId },
      type: 'generated-workflow.approval.decided',
      outcome: 'completed',
      metadata: { runId, step: request.step, action, state: result.state },
    });
    return json(
      200,
      await view(runner, runId, runsDir(dataConfig, workspace.workspaceId, definition.definitionId), dataConfig.dataRootDir),
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
          await (await runnerFor(deps, workspace.value, definition)).tick();
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
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs', guarded(list));
  router.get('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId', guarded(status));
  router.post('/workspaces/:workspaceId/generated-workflows/:definitionId/runs/:runId/approvals/:approvalId', guarded(decide));
}
