import { actorFromPrincipal, type AuditEventDraft } from '@xo/audit';
import { normalizeToFallbackKey, validateCapabilityInput } from '@xo/capability-contract';
import { ErrorCode, RuntimeError, XoError } from '@xo/errors';
import type { ExternalToolWiring } from '@xo/runtime';
import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import {
  EnvironmentId,
  NodeId,
  WorkflowExecutor,
  WorkflowInstanceId,
  createCheckpoint,
  createInitialState,
  evaluateCondition,
  type NodeHandler,
  type WorkflowGraph,
  type WorkflowNode,
} from '@xo/runtime';
import { ContentHash, err, ok, type CapabilityInputSchema, type Result } from '@xo/types';
import { fromJson, type XoirGraph, type XoirGraphJson } from '@xo/xoir';
import { lowerCondition, lowerToWorkflowGraph, type CapabilityStep, type ProcedureDefinition, type ProcedureFinding } from '@xo/procedure';
import type { AuditService } from '../audit/audit-service.js';
import type { ApprovalStore } from '../approvals/approval.js';
import { deriveCapabilityApprovalState } from '../approvals/approval-binding.js';
import { verifyApproval } from '../approvals/approval-enforcement.js';
import type { CompilationStore } from '../compilations/compilation.js';
import { executeApprovedCapability, preflightCapabilityAuthorization } from '../executions/execute-capability.js';
import type { ExecutionOutcomeInput, ExecutionRecord, ExecutionStore, HumanTaskDecision } from '../executions/execution.js';
import { withExecutionLock } from '../executions/execution-lock.js';
import { resolveHumanTaskExecution } from '../executions/resolve-human-task.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { FsProcedureStore } from './fs-procedure-store.js';
import {
  ProcedureConflictError,
  mintProcedureExecutionId,
  PROCEDURE_EXECUTION_SCHEMA,
  type FsProcedureExecutionStore,
  type ProcedureExecutionRecord,
  type ProcedureFailureClass,
  type ProcedureStepState,
} from './procedure-execution.js';
import { computeLifecycle } from './procedure-approval.js';
import type { ProcedureApprovalRecord, ProcedureVersionRecord } from './procedure.js';
import { compilationLoaderFromStore, schemasByContract, validateAgainstRegistry, type RegistrySnapshot } from './registry-validation.js';

/**
 * P1.1 M3 — deterministic procedure execution: branching, value-faithful data flow, pause at a human gate, resume (also across a
 * process restart: all state is the persisted record), per-step authorization, idempotent start. EFFECT-FREE: nothing here
 * writes outside XO's own stores; effects, MCP, cancel-in-flight and step retries are not part of this milestone.
 *
 * Reuse, not a second engine: the runtime `WorkflowExecutor` walks the lowered graph (decision edges, conditions); each
 * capability step runs through `executeApprovedCapability` (same contract rebuild, permission gate and graph-hash pinning as the
 * direct execution route); human tasks are the existing `ExecutionStore` human tasks resolved by `resolveHumanTaskExecution`.
 */

const STEP_NODE_TYPE = 'custom:procedure-step';
const START = '__start';
const END = '__end';

export interface ProcedureRunnerContext {
  readonly workspace: WorkspaceRecord;
  readonly principal: AuthenticatedPrincipal;
  readonly permissionManager: PermissionManager;
  readonly compilationStore: CompilationStore;
  readonly approvalStore: ApprovalStore;
  readonly executionStore: ExecutionStore;
  readonly procedures: FsProcedureStore;
  readonly records: FsProcedureExecutionStore;
  readonly audit: AuditService;
  readonly correlationId: string;
  /**
   * Per-step wall-clock timeout. DELIBERATELY OPTIONAL with NO default: a timeout is a resource limit and no value is
   * owner-approved (O-5). When a server sets it, a step that overruns fails with class `timeout`. The in-flight call is not
   * cancelled (cancel-in-flight is out of scope).
   */
  readonly stepTimeoutMs?: number;
  /**
   * TEST-ONLY SEAM (owner decision D2, 2026-10-21). Awaited INSIDE the timed work, immediately before the real
   * `executeApprovedCapability` call. It can only DELAY the real call: it cannot replace, skip or alter execution, so it is
   * not an execution bypass. Ignored when NODE_ENV is 'production'. Not exposed through HTTP or environment configuration.
   */
  readonly testBeforeStepExecute?: () => Promise<void>;
  /**
   * M4 — explicit, host-owned external_tool adapter wiring. DELIBERATELY OPTIONAL with no default: when absent, a step whose capability is an
   * external_tool never executes (it stays unresolved and the step fails closed before anything is dispatched). Never configurable through
   * HTTP, the procedure definition, or client input. No retry of an external dispatch exists anywhere in this runner.
   */
  readonly externalTools?: ExternalToolWiring;
}

/** M4 step error codes for external_tool dispatches (strings, so no shared ErrorCode enum is widened). */
export const EFFECT_OUTCOME_UNKNOWN_CODE = 'XO_EXTERNAL_EFFECT_OUTCOME_UNKNOWN';
export const EFFECT_CONFIRMED_FAILURE_CODE = 'XO_EXTERNAL_EFFECT_CONFIRMED_FAILURE_NO_EFFECT';

const enc = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Defence in depth for the runtime `resolvePath` (no own-property check): step outputs handed to conditions have NO prototype. */
function nullProto(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(nullProto);
  if (isObj(value)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const k of Object.keys(value)) out[k] = nullProto(value[k]);
    return out;
  }
  return value;
}

export function rejectedFindings(message: string, findings: readonly ProcedureFinding[]): XoError {
  return new XoError(ErrorCode.INVALID_ARGUMENT, message, { context: { findings: findings.map((f) => ({ code: f.code, path: f.path })) } });
}

// ───────────────────────────── registry / authorization ─────────────────────────────

interface Runtime {
  readonly compilationId: string;
  readonly graphJson: unknown;
  readonly graph: XoirGraph;
  readonly graphHash: string;
  readonly sourceDigest: string;
  readonly snapshot: RegistrySnapshot;
}

interface Denial {
  readonly failureClass: ProcedureFailureClass;
  readonly code: string;
  readonly message: string;
}

/** Fresh, authoritative registry read (never cached across steps): the procedure must STILL validate and still match its approval. */
async function loadRuntime(
  ctx: ProcedureRunnerContext,
  def: ProcedureDefinition,
  approval: ProcedureApprovalRecord | undefined,
): Promise<Result<Runtime, Denial>> {
  const stale = (message: string): Result<Runtime, Denial> =>
    err({ failureClass: 'stale_binding', code: ErrorCode.RUNTIME_PERMISSION_DENIED, message });
  const ref = def.compilationRef;
  if (ref === undefined) return stale('the procedure records no compilation reference');
  const registry = await validateAgainstRegistry(def, compilationLoaderFromStore(ctx.compilationStore));
  if (!registry.ok)
    return stale(`the procedure no longer validates against the registry (${registry.findings.map((f) => f.code).join(', ')})`);
  const compilation = await ctx.compilationStore.get(ref.compilationId);
  const json = await ctx.compilationStore.getCompiledGraph(ref.compilationId);
  if (!compilation.ok || !json.ok) return stale('the compilation could not be read');
  const graph = fromJson(json.value as XoirGraphJson);
  if (!graph.ok) return stale('the compiled graph could not be read');
  const graphHash = graph.value.contentHash();
  if (graphHash !== registry.snapshot.graphHash) return stale('the compiled graph changed while it was being read');
  if (approval !== undefined && approval.binding.registryStateDigest !== registry.snapshot.digest) {
    return stale('the registry state changed since this procedure was approved');
  }
  return ok({
    compilationId: ref.compilationId,
    graphJson: json.value,
    graph: graph.value,
    graphHash,
    sourceDigest: compilation.value.sourceDigestSha256,
    snapshot: registry.snapshot,
  });
}

/** Per-step authorization, recomputed at the moment of use: capability approval (existing system) + permission gate + approved per-step state. */
async function authorizeStep(
  ctx: ProcedureRunnerContext,
  rt: Runtime,
  approval: ProcedureApprovalRecord | undefined,
  step: CapabilityStep,
): Promise<Denial | undefined> {
  const denied = (message: string, failureClass: ProcedureFailureClass = 'authorization'): Denial => ({
    failureClass,
    code: ErrorCode.RUNTIME_PERMISSION_DENIED,
    message,
  });
  const verdict = await verifyApproval(
    ctx.approvalStore,
    { workspaceId: ctx.workspace.workspaceId, compilationId: rt.compilationId, capabilityId: step.capabilityId },
    deriveCapabilityApprovalState(rt.graph, step.capabilityId, rt.sourceDigest),
  );
  if (!verdict.ok) return denied(`the capability approval could not be read (${verdict.error.message})`);
  if (!verdict.value.approved) return denied(verdict.value.message);
  const preflight = await preflightCapabilityAuthorization(rt.graphJson, step.capabilityId, {
    permissionManager: ctx.permissionManager,
    subject: ctx.principal,
  });
  if (preflight.kind !== 'authorized') return denied(preflight.errorMessage);
  if (approval !== undefined) {
    const approved = approval.binding.steps.find((s) => s.stepId === step.id);
    const current = rt.snapshot.steps.find((s) => s.stepId === step.id);
    if (
      approved === undefined ||
      current === undefined ||
      approved.contractHash !== current.contractContentHash ||
      approved.permissionFingerprint !== current.declarationFingerprint ||
      approved.bindingId !== current.bindingId
    ) {
      return denied(`the approved state of step "${step.id}" no longer matches the registry`, 'stale_binding');
    }
  }
  return undefined;
}

// ───────────────────────────── start-time input validation (owner decision 4) ─────────────────────────────

/**
 * Validates the resolved procedure input BEFORE anything is persisted or executed. The ONLY schema source is the consumer's own
 * capability input schema (the same contract representation `executeApprovedCapability` and the workflow runner use) for the
 * parameters bound with `{input: …}`. Guaranteed: the contract/schema of every capability the registry resolved. Not guaranteed
 * (so it fails closed): a consumer without a schema, an input-bound parameter the schema does not declare, a required property
 * nothing binds. Step-bound values are checked when they exist (at run time), never guessed here.
 */
export function validateStartInput(def: ProcedureDefinition, rt: Runtime, input: Readonly<Record<string, unknown>>): ProcedureFinding[] {
  const findings: ProcedureFinding[] = [];
  const add = (code: ProcedureFinding['code'], path: string): void => void findings.push({ code, path });
  const schemas = schemasByContract(rt.graph);
  const referenced = new Set<string>();
  def.steps.forEach((step, i) => {
    if (step.kind !== 'capability') return;
    const state = rt.snapshot.steps.find((s) => s.stepId === step.id);
    const schema = state === undefined ? undefined : schemas.get(state.contractId);
    const inputBound = (step.inputBindings ?? []).filter((b): b is typeof b & { from: { input: string } } => 'input' in b.from);
    for (const b of inputBound) referenced.add(b.from.input);
    if (schema === undefined) {
      if (inputBound.length > 0) add('PROC_INPUT_CONTRACT_UNAVAILABLE', `/steps/${i}`);
      return;
    }
    const keyOf = (param: string): string => normalizeToFallbackKey(param);
    const boundKeys = new Set((step.inputBindings ?? []).map((b) => keyOf(b.param)));
    for (const required of schema.required ?? []) if (!boundKeys.has(required)) add('PROC_UNBOUND_REQUIRED_INPUT', `/steps/${i}`);
    const props: Record<string, CapabilityInputSchema['properties'][string]> = {};
    const subset: Record<string, unknown> = {};
    const nameOf = new Map<string, string>();
    for (const b of inputBound) {
      const key = keyOf(b.param);
      const declared = has(schema.properties, key) ? schema.properties[key] : undefined;
      if (declared === undefined) {
        add('PROC_INPUT_UNDECLARED', `/input/${enc(b.from.input)}`);
        continue;
      }
      props[key] = declared;
      nameOf.set(key, b.from.input);
      if (has(input, b.from.input) && input[b.from.input] !== undefined) subset[key] = input[b.from.input];
      else if ((schema.required ?? []).includes(key)) add('PROC_INPUT_MISSING', `/input/${enc(b.from.input)}`);
    }
    const sub: CapabilityInputSchema = {
      type: 'object',
      properties: props,
      required: (schema.required ?? []).filter((r) => key_in(props, r)),
    } as CapabilityInputSchema;
    const validation = validateCapabilityInput(sub, subset);
    if (!validation.valid) {
      for (const issue of validation.issues) {
        const name = nameOf.get(issue.property);
        if (name === undefined || findings.some((f) => f.path === `/input/${enc(name)}`)) continue;
        add('PROC_INPUT_INVALID', `/input/${enc(name)}`);
      }
    }
  });
  for (const key of Object.keys(input)) if (!referenced.has(key)) add('PROC_INPUT_UNDECLARED', `/input/${enc(key)}`);
  return findings;
}
const key_in = (o: object, k: string): boolean => has(o, k);

// ───────────────────────────── record transitions ─────────────────────────────

class Holder {
  constructor(
    private readonly store: FsProcedureExecutionStore,
    private held: ProcedureExecutionRecord,
  ) {}
  get current(): ProcedureExecutionRecord {
    return this.held;
  }
  async update(fn: (r: ProcedureExecutionRecord, now: string) => ProcedureExecutionRecord): Promise<ProcedureExecutionRecord> {
    const previous = this.held;
    const now = new Date().toISOString();
    const next: ProcedureExecutionRecord = { ...fn(previous, now), revision: previous.revision + 1, updatedAt: now };
    this.held = await this.store.save(next, previous.revision);
    return this.held;
  }
}

const replaceStep = (steps: readonly ProcedureStepState[], stepId: string, patch: Partial<ProcedureStepState>): ProcedureStepState[] =>
  steps.map((s) => (s.stepId === stepId ? { ...s, ...patch } : s));

const withoutKey = <T extends object>(o: T, key: string): T => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)) as T;

type StepResult = { readonly kind: 'succeeded'; readonly output: unknown } | { readonly kind: 'waiting' } | { readonly kind: 'failed' };

/** Audit detail events are best-effort (`tryRecord`): the DURABLE precondition is the route's `procedure.attempted` before anything runs. */
async function emit(
  ctx: ProcedureRunnerContext,
  record: ProcedureExecutionRecord,
  type: AuditEventDraft['type'],
  outcome: AuditEventDraft['outcome'],
  extra: { stepId?: string; reasonCode?: string; metadata?: Record<string, string | number | boolean> } = {},
): Promise<void> {
  await ctx.audit.tryRecord({
    type,
    action: type.startsWith('procedure.step') ? 'run.procedure.step' : 'run.procedure',
    outcome,
    actor: actorFromPrincipal(ctx.principal),
    target:
      extra.stepId !== undefined
        ? { kind: 'procedure-step', id: extra.stepId, workspaceId: ctx.workspace.workspaceId }
        : { kind: 'procedure-execution', id: record.procedureExecutionId, workspaceId: ctx.workspace.workspaceId },
    correlationId: ctx.correlationId,
    ...(extra.reasonCode !== undefined ? { reasonCode: extra.reasonCode } : {}),
    metadata: {
      executionId: record.procedureExecutionId,
      procedureId: record.procedureId,
      version: record.version,
      ...(extra.metadata ?? {}),
    },
  });
}

const reasonOf = (c: ProcedureFailureClass): string => `PROCEDURE_${c.toUpperCase()}`;

async function failExecution(
  ctx: ProcedureRunnerContext,
  holder: Holder,
  failureClass: ProcedureFailureClass,
  code: string,
  stepId?: string,
): Promise<void> {
  await holder.update((r, now) => ({
    ...withoutKey(r, 'waitingStepId'),
    status: 'failed',
    failure: { class: failureClass, code },
    completedAt: now,
    steps: r.steps.map((s) => (s.status === 'pending' ? { ...s, status: 'skipped' as const } : s)),
  }));
  if (stepId !== undefined)
    await emit(ctx, holder.current, 'procedure.step.failed', 'failed', {
      stepId,
      reasonCode: reasonOf(failureClass),
      metadata: { failureClass },
    });
  await emit(ctx, holder.current, 'procedure.execution.failed', 'failed', {
    reasonCode: reasonOf(failureClass),
    metadata: { failureClass },
  });
}

// ───────────────────────────── the driver ─────────────────────────────

function stepGraph(def: ProcedureDefinition, startAt: string): WorkflowGraph {
  const lowered = lowerToWorkflowGraph(def);
  const repointed = lowered.edges.map((e) => (String(e.from) === START ? { ...e, to: NodeId(startAt) } : e));
  // The executor requires every node to be reachable: keep only what is reachable from the (re-pointed) start.
  const reachable = new Set<string>([START]);
  const queue = [START];
  while (queue.length > 0) {
    const from = queue.pop() as string;
    for (const e of repointed) {
      if (String(e.from) === from && !reachable.has(String(e.to))) {
        reachable.add(String(e.to));
        queue.push(String(e.to));
      }
    }
  }
  const nodes: WorkflowNode[] = lowered.nodes
    .filter((n) => reachable.has(String(n.id)))
    .map((n) => (n.type === 'capability' ? { id: n.id, type: STEP_NODE_TYPE, config: { stepId: String(n.id) } } : n));
  const edges = repointed.filter((e) => reachable.has(String(e.from)) && reachable.has(String(e.to)));
  return { ...lowered, nodes, edges } as WorkflowGraph;
}

function stepInputOf(step: CapabilityStep, record: ProcedureExecutionRecord): Result<Record<string, unknown>, ProcedureFinding> {
  const out: Record<string, unknown> = {};
  for (const [i, b] of (step.inputBindings ?? []).entries()) {
    const key = normalizeToFallbackKey(b.param);
    if ('input' in b.from) {
      if (has(record.input, b.from.input) && record.input[b.from.input] !== undefined) out[key] = record.input[b.from.input];
      continue; // presence of required client input was validated at start
    }
    const produced = record.outputs[b.from.step];
    // Value-faithful: a producer's `false`/0/'' is carried as is. A value that does not exist is NEVER fabricated or defaulted.
    if (!isObj(produced) || !has(produced, b.from.output))
      return err({ code: 'PROC_INPUT_MISSING', path: `/steps/${step.id}/inputBindings/${i}` });
    out[key] = produced[b.from.output];
  }
  return ok(out);
}

export async function raceTimeout<T>(work: Promise<T>, ms: number | undefined): Promise<T | 'timeout'> {
  if (ms === undefined) return work;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runStep(
  ctx: ProcedureRunnerContext,
  holder: Holder,
  def: ProcedureDefinition,
  approval: ProcedureApprovalRecord | undefined,
  step: CapabilityStep,
): Promise<StepResult> {
  const fail = async (failureClass: ProcedureFailureClass, code: string, executionId?: string, message?: string): Promise<StepResult> => {
    if (executionId !== undefined) {
      const failedOutcome: ExecutionOutcomeInput = { status: 'failed', errorCode: code, errorMessage: message ?? failureClass };
      await ctx.executionStore.complete(executionId, failedOutcome);
    }
    await holder.update((r, now) => ({
      ...r,
      steps: replaceStep(r.steps, step.id, { status: 'failed', failureClass, errorCode: code, completedAt: now }),
    }));
    await failExecution(ctx, holder, failureClass, code, step.id);
    return { kind: 'failed' };
  };
  // Per-step authorization against a FRESH registry read, before anything is created or executed for this step.
  const rt = await loadRuntime(ctx, def, approval);
  if (!rt.ok) return fail(rt.error.failureClass, rt.error.code);
  const denial = await authorizeStep(ctx, rt.value, approval, step);
  if (denial !== undefined) return fail(denial.failureClass, denial.code);
  const input = stepInputOf(step, holder.current);
  if (!input.ok) return fail('input_invalid', ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID);
  const created = await ctx.executionStore.create(ctx.workspace.workspaceId, ctx.principal, {
    compilationId: rt.value.compilationId,
    capabilityId: step.capabilityId,
    input: input.value,
  });
  if (!created.ok) throw created.error;
  const executionId = created.value.executionId;
  await holder.update((r) => ({ ...r, steps: replaceStep(r.steps, step.id, { status: 'running', executionId }) }));
  const seam = process.env['NODE_ENV'] === 'production' ? undefined : ctx.testBeforeStepExecute;
  const outcome = await raceTimeout(
    (async () => {
      if (seam !== undefined) await seam();
      return executeApprovedCapability(
        rt.value.graphJson,
        step.capabilityId,
        input.value,
        { permissionManager: ctx.permissionManager, subject: ctx.principal },
        {
          validateInputSchema: false,
          preflightGraphHash: ContentHash(rt.value.graphHash),
          // M4: server-derived, one dispatch per (procedure execution, step). Never taken from the client.
          ...(ctx.externalTools !== undefined
            ? { externalTools: ctx.externalTools, dispatchKey: `${holder.current.procedureExecutionId}:${step.id}` }
            : {}),
        },
      );
    })(),
    ctx.stepTimeoutMs,
  );
  if (outcome === 'timeout') return fail('timeout', 'XO_PROCEDURE_STEP_TIMEOUT', executionId, 'step timed out');
  switch (outcome.kind) {
    case 'succeeded': {
      const completed = await ctx.executionStore.complete(executionId, {
        status: 'succeeded',
        output: outcome.output,
        ...(outcome.contractId !== undefined ? { contractId: outcome.contractId } : {}),
        ...(outcome.bindingId !== undefined ? { bindingId: outcome.bindingId } : {}),
      });
      if (!completed.ok) throw completed.error;
      await holder.update((r, now) => ({
        ...r,
        outputs: { ...r.outputs, [step.id]: outcome.output },
        steps: replaceStep(r.steps, step.id, { status: 'succeeded', completedAt: now }),
      }));
      await emit(ctx, holder.current, 'procedure.step.completed', 'completed', { stepId: step.id });
      return { kind: 'succeeded', output: outcome.output };
    }
    case 'waiting_for_human': {
      const completed = await ctx.executionStore.complete(executionId, {
        status: 'waiting_for_human',
        output: outcome.output,
        ...(outcome.contractId !== undefined ? { contractId: outcome.contractId } : {}),
        ...(outcome.bindingId !== undefined ? { bindingId: outcome.bindingId } : {}),
      });
      if (!completed.ok) throw completed.error;
      await holder.update((r) => ({
        ...r,
        status: 'waiting_for_human',
        waitingStepId: step.id,
        steps: replaceStep(r.steps, step.id, { status: 'waiting_for_human', executionId }),
      }));
      await emit(ctx, holder.current, 'procedure.execution.waiting_for_human', 'allowed', { metadata: { stepId: step.id } });
      return { kind: 'waiting' };
    }
    case 'invalid_input':
      return fail('input_invalid', ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID, executionId);
    case 'unresolved':
      return fail('capability_error', ErrorCode.WORKFLOW_NOT_EXECUTABLE, executionId, outcome.reason);
    case 'error':
      // M4: an external dispatch that ended ambiguously is NEVER reported as a plain failure or a success: it gets its own code, and
      // the message states that reconciliation is required before any further dispatch. No retry, no automatic recovery.
      if (outcome.effectState === 'outcome_unknown') {
        return fail('capability_error', EFFECT_OUTCOME_UNKNOWN_CODE, executionId, outcome.errorMessage);
      }
      if (outcome.effectState === 'confirmed_failure_no_effect') {
        return fail('capability_error', EFFECT_CONFIRMED_FAILURE_CODE, executionId, outcome.errorMessage);
      }
      return fail(
        outcome.errorCode === ErrorCode.RUNTIME_PERMISSION_DENIED ? 'authorization' : 'capability_error',
        outcome.errorCode,
        executionId,
        outcome.errorMessage,
      );
  }
}

/** Runs the lowered graph from `startAt` until it completes, pauses at a human gate, or fails. Records the outcome on the holder. */
async function drive(
  ctx: ProcedureRunnerContext,
  holder: Holder,
  def: ProcedureDefinition,
  approval: ProcedureApprovalRecord | undefined,
  startAt: string,
): Promise<void> {
  const byId = new Map(def.steps.filter((s): s is CapabilityStep => s.kind === 'capability').map((s) => [s.id, s] as const));
  let paused = false;
  let failed = false;
  const handler = async (node: WorkflowNode): ReturnType<NodeHandler> => {
    const step = byId.get(String(node.config?.['stepId']));
    if (step === undefined) {
      failed = true;
      await failExecution(ctx, holder, 'internal', ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND);
      return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND, 'unknown procedure step'));
    }
    const result = await runStep(ctx, holder, def, approval, step);
    if (result.kind === 'succeeded') return ok({ output: nullProto(result.output) });
    if (result.kind === 'waiting') paused = true;
    else failed = true;
    // Returning an error ends this engine run; `paused` / `failed` tell the driver it is NOT an engine fault.
    return err(
      new RuntimeError(ErrorCode.RUNTIME_SESSION_INVALID_STATE, result.kind === 'waiting' ? 'paused for a human decision' : 'step failed'),
    );
  };
  const engine = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable: procedure graphs contain no built-in "capability" nodes');
    },
    { customNodeHandlers: new Map([[STEP_NODE_TYPE, handler]]) },
  );
  const now = new Date();
  const outputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(holder.current.outputs)) outputs[k] = nullProto(v);
  const instance = Object.freeze({
    workflowInstanceId: WorkflowInstanceId(holder.current.procedureExecutionId),
    graph: stepGraph(def, startAt),
    state: { ...createInitialState(() => now), outputs },
    status: 'suspended' as const,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  const environment = {
    environmentId: EnvironmentId(`env_proc_${holder.current.procedureExecutionId}`),
    hostProfile: { family: 'generic' as const, capabilities: [] },
    createdAt: now.toISOString(),
  };
  const result = await engine.resume(createCheckpoint(instance), environment);
  if (paused || failed) return;
  if (result.error !== undefined) {
    await failExecution(ctx, holder, 'internal', result.error.code);
    return;
  }
  // Postconditions: the procedure's `then` conditions must all hold over the recorded outputs.
  const finalOutputs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(holder.current.outputs)) finalOutputs[k] = nullProto(v);
  for (const cond of def.then ?? []) {
    if (!evaluateCondition(lowerCondition(cond), finalOutputs)) {
      await failExecution(ctx, holder, 'failed_postcondition', 'XO_PROCEDURE_POSTCONDITION_FAILED');
      return;
    }
  }
  await holder.update((r, at) => ({
    ...withoutKey(r, 'waitingStepId'),
    status: 'completed',
    completedAt: at,
    steps: r.steps.map((s) => (s.status === 'pending' ? { ...s, status: 'skipped' as const } : s)),
  }));
  await emit(ctx, holder.current, 'procedure.execution.completed', 'completed');
}

// ───────────────────────────── start / resume / read ─────────────────────────────

export interface StartHooks {
  /** Idempotency gate (M6 line). Return `replay` to return an existing execution without starting another. */
  readonly gate?: () => Promise<{ readonly kind: 'proceed' } | { readonly kind: 'replay'; readonly procedureExecutionId: string }>;
  readonly beforeCreate?: (procedureExecutionId: string) => Promise<void>;
}

export async function startProcedureExecution(
  ctx: ProcedureRunnerContext,
  version: ProcedureVersionRecord,
  input: Readonly<Record<string, unknown>>,
  hooks: StartHooks = {},
): Promise<ProcedureExecutionRecord> {
  const def = version.definition;
  // 1. Lifecycle at start (N-7 / N-15): the stored definition is re-verified on read; approval + registry state are recomputed NOW.
  const approvalLookup = await ctx.procedures.getApproval(version.procedureId, version.version);
  if (!approvalLookup.ok) throw approvalLookup.error;
  const registry = await validateAgainstRegistry(def, compilationLoaderFromStore(ctx.compilationStore));
  const lifecycle = computeLifecycle(version, approvalLookup.value, registry);
  if (lifecycle !== 'approved' || approvalLookup.value.kind !== 'ok' || !registry.ok) {
    throw new XoError(
      ErrorCode.RUNTIME_PERMISSION_DENIED,
      `procedure "${version.procedureId}" version ${version.version} is not approved for its current registry state (lifecycle: ${lifecycle}); nothing was started`,
    );
  }
  const approval = approvalLookup.value.record;
  const rt = await loadRuntime(ctx, def, approval);
  if (!rt.ok) throw new XoError(ErrorCode.RUNTIME_PERMISSION_DENIED, `${rt.error.message}; nothing was started`);
  // 2. Authorization of EVERY step before any record exists: a denial leaves zero records.
  for (const step of def.steps) {
    if (step.kind !== 'capability') continue;
    const denial = await authorizeStep(ctx, rt.value, approval, step);
    if (denial !== undefined)
      throw new XoError(ErrorCode.RUNTIME_PERMISSION_DENIED, `step "${step.id}": ${denial.message}; nothing was started`);
  }
  // 3. Input validation (owner decision 4) before persistence and before any execution.
  const problems = validateStartInput(def, rt.value, input);
  if (problems.length > 0) throw rejectedFindings('procedure input rejected', problems);
  // 4. Idempotency, then the record.
  if (hooks.gate !== undefined) {
    const gated = await hooks.gate();
    if (gated.kind === 'replay') {
      const existing = await ctx.records.get(gated.procedureExecutionId);
      if (!existing.ok) throw existing.error;
      return existing.value;
    }
  }
  const id = mintProcedureExecutionId();
  if (hooks.beforeCreate !== undefined) await hooks.beforeCreate(id);
  const now = new Date().toISOString();
  const created = await ctx.records.create({
    schemaVersion: PROCEDURE_EXECUTION_SCHEMA,
    procedureExecutionId: id,
    workspaceId: ctx.workspace.workspaceId,
    procedureId: version.procedureId,
    version: version.version,
    procedureHash: version.procedureHash,
    initiator: { kind: ctx.principal.kind, id: ctx.principal.id },
    revision: 0,
    status: 'running',
    input,
    outputs: {},
    steps: def.steps
      .filter((s): s is CapabilityStep => s.kind === 'capability')
      .map((s) => ({ stepId: s.id, capabilityId: s.capabilityId, status: 'pending' as const })),
    createdAt: now,
    updatedAt: now,
  });
  if (!created.ok) throw created.error;
  const holder = new Holder(ctx.records, created.value);
  await emit(ctx, holder.current, 'procedure.execution.started', 'started');
  return withExecutionLock(id, async () => {
    const entry = entryStepId(def);
    await drive(ctx, holder, def, approval, entry);
    return holder.current;
  });
}

function entryStepId(def: ProcedureDefinition): string {
  const incoming = new Set<string>();
  for (const s of def.steps) {
    if (s.kind === 'decision') {
      incoming.add(s.then);
      incoming.add(s.else);
    } else if (s.next !== undefined) incoming.add(s.next);
  }
  const entry = def.steps.find((s) => !incoming.has(s.id));
  if (entry === undefined) throw new XoError(ErrorCode.WORKFLOW_NOT_EXECUTABLE, 'procedure has no entry step');
  return entry.id;
}

export interface ResumeRequest {
  readonly decision: HumanTaskDecision;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly expectedRevision?: number;
  readonly expectedStepExecutionId?: string;
}

export async function resumeProcedureExecution(
  ctx: ProcedureRunnerContext,
  procedureExecutionId: string,
  request: ResumeRequest,
): Promise<ProcedureExecutionRecord> {
  return withExecutionLock(procedureExecutionId, async () => {
    const found = await ctx.records.get(procedureExecutionId);
    if (!found.ok) throw found.error;
    const record = found.value;
    if (record.status === 'completed' || record.status === 'failed') {
      throw new ProcedureConflictError(`procedure execution is already ${record.status}; there is nothing to resume`, 'terminal');
    }
    if (request.expectedRevision !== undefined && request.expectedRevision !== record.revision) {
      throw new ProcedureConflictError(
        `procedure execution is at revision ${record.revision}, not the expected ${request.expectedRevision}`,
        'stale_revision',
        { expectedRevision: request.expectedRevision },
      );
    }
    if (record.status !== 'waiting_for_human' || record.waitingStepId === undefined) {
      throw new ProcedureConflictError('procedure execution is not waiting for a human decision', 'not_waiting');
    }
    const waiting = record.steps.find((s) => s.stepId === record.waitingStepId);
    if (waiting?.executionId === undefined) throw new ProcedureConflictError('the waiting step records no human task', 'not_waiting');
    if (request.expectedStepExecutionId !== undefined && request.expectedStepExecutionId !== waiting.executionId) {
      throw new ProcedureConflictError(
        '"expectedStepExecutionId" does not match the pending human task; the decision was NOT applied',
        'stale_step_execution',
      );
    }
    const version = await ctx.procedures.getVersion(record.procedureId, record.version);
    if (!version.ok) throw version.error;
    if (version.value.kind !== 'ok' || version.value.record.procedureHash !== record.procedureHash) {
      throw new XoError(
        ErrorCode.RUNTIME_PERMISSION_DENIED,
        'the stored procedure no longer matches the one this execution started with; nothing was resumed',
      );
    }
    const def = version.value.record.definition;
    const approvalLookup = await ctx.procedures.getApproval(record.procedureId, record.version);
    if (!approvalLookup.ok) throw approvalLookup.error;
    // Review finding 1: an execution may only continue under the approval it started with. A missing or malformed approval record must not
    // silently disable the registry-digest and per-step approved-state checks (both skip when `approval` is undefined): fail closed, before the
    // human decision is applied.
    if (approvalLookup.value.kind !== 'ok') {
      throw new XoError(
        ErrorCode.RUNTIME_PERMISSION_DENIED,
        `the procedure approval record is ${approvalLookup.value.kind === 'none' ? 'missing' : 'unreadable'}; nothing was resumed`,
      );
    }
    const approval = approvalLookup.value.record;
    const outcome = await resolveHumanTaskExecution(
      ctx.executionStore,
      ctx.compilationStore,
      waiting.executionId,
      request.decision,
      request.data,
      ctx.principal,
      ctx.permissionManager,
      { store: ctx.approvalStore, workspaceId: ctx.workspace.workspaceId },
    );
    switch (outcome.kind) {
      case 'not_found':
      case 'error':
        throw outcome.error;
      case 'not_a_human_task':
        throw new ProcedureConflictError('the waiting step is not a human task', 'not_waiting');
      case 'already_resolved':
        throw new ProcedureConflictError('the human task was already resolved by another request', 'stale_step_execution');
      case 'resolved':
        break;
    }
    const holder = new Holder(ctx.records, record);
    const exec: ExecutionRecord = outcome.record;
    await emit(ctx, holder.current, 'procedure.execution.resumed', 'started', {
      metadata: { stepId: waiting.stepId, decision: request.decision },
    });
    if (exec.status === 'succeeded') {
      await holder.update((r, now) => ({
        ...withoutKey(r, 'waitingStepId'),
        status: 'running',
        outputs: { ...r.outputs, [waiting.stepId]: exec.output },
        steps: replaceStep(r.steps, waiting.stepId, { status: 'succeeded', completedAt: now }),
      }));
      await emit(ctx, holder.current, 'procedure.step.completed', 'completed', { stepId: waiting.stepId });
      const step = def.steps.find((s): s is CapabilityStep => s.kind === 'capability' && s.id === waiting.stepId);
      await drive(ctx, holder, def, approval, step?.next ?? END);
      return holder.current;
    }
    const failureClass: ProcedureFailureClass = exec.status === 'rejected' ? 'human_rejected' : 'capability_error';
    await holder.update((r, now) => ({
      ...r,
      steps: replaceStep(r.steps, waiting.stepId, { status: 'failed', failureClass, completedAt: now }),
    }));
    await failExecution(
      ctx,
      holder,
      failureClass,
      exec.status === 'rejected' ? 'XO_PROCEDURE_HUMAN_REJECTED' : (exec.errorCode ?? ErrorCode.HITL_RESUME_UNSUPPORTED),
      waiting.stepId,
    );
    return holder.current;
  });
}
