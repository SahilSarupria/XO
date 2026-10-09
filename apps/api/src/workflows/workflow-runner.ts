import { err, ok, type Result } from '@xo/types';
import type { CapabilityInputSchema } from '@xo/types';
import { ErrorCode, NotFoundError, RuntimeError, XoError } from '@xo/errors';
import { lowerCapabilitiesToManifest } from '@xo/compiler';
import { validateCapabilityInput } from '@xo/capability-contract';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import type { XoirGraph } from '@xo/xoir';
import {
  EnvironmentId,
  NATIVE_CAPABILITY_REQUESTER,
  NodeId,
  RuntimeCapabilityExecutor,
  WorkflowExecutor,
  WorkflowInstanceId,
  createCheckpoint,
  createInitialState,
  makeCapabilityAuthorityNodeHandler,
  type ExecutionEnvironment,
  type RuntimeCapabilityExecutionRequest,
  type RuntimeCapabilityExecutionResult,
  type WorkflowGraph,
  type WorkflowInstance,
} from '@xo/runtime';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { CompilationRecord, CompilationStore } from '../compilations/compilation.js';
import type { ApprovalStore } from '../approvals/approval.js';
import { isApproved } from '../approvals/approval.js';
import type { ExecutionOutcomeInput, ExecutionRecord, ExecutionStore, HumanTaskDecision } from '../executions/execution.js';
import { withExecutionLock } from '../executions/execution-lock.js';
import { resolveHumanTaskExecution } from '../executions/resolve-human-task.js';
import { mintWorkflowExecutionId } from './fs-workflow-execution-store.js';
import { TERMINAL_WORKFLOW_STATUSES, WorkflowConflictError, type WorkflowExecutionRecord, type WorkflowExecutionStore } from './workflow-execution.js';
import { composeCompilationWorkflows, findWorkflow, resolveWorkflow, workflowNotExecutableError, type ResolvedWorkflow } from './workflow-catalog.js';
import { firstRunnableStepIndex, withHumanResolution, withInterrupted, withRunning, withStepOutcome, withStepStarted, withWorkflowFailure, type StepOutcome } from './workflow-transitions.js';

/**
 * P0.8's orchestration layer. It owns exactly three things the existing
 * runtime does not provide:
 *
 *   1. DURABLE workflow + step state (`WorkflowExecutionRecord`), with
 *      revision-checked persistence.
 *   2. STOPPING at a human-in-the-loop step and CONTINUING after the
 *      human's decision. `@xo/runtime`'s `WorkflowExecutor` has no pause
 *      primitive: a HITL node's escalation record is an ordinary
 *      completed node and the engine simply proceeds to the next one
 *      (`deriveWorkflowRunStatus` only relabels the run afterwards). P0.8
 *      does not rely on that label. Instead the engine is run in
 *      SEGMENTS: each segment is the prefix of the bridge's own
 *      sequential graph that ends at the first not-yet-done
 *      `human_in_the_loop` step (a binding class that ALWAYS escalates —
 *      see `ActionEscalationBindingResolver`), or at the last step. A
 *      segment therefore can never run past a HITL step, and the
 *      pause/continue state lives in the API-level record, not in the
 *      engine. Prior steps' outputs are re-seeded into the engine's own
 *      `WorkflowState.outputs` from the persisted record so the bridge's
 *      unmodified proven-data-flow injection still finds them.
 *   3. One `ExecutionRecord` (P0.5) per step, created/completed by a thin
 *      wrapper AROUND — not a subclass of — the unmodified
 *      `RuntimeCapabilityExecutor`.
 *
 * Everything else — composition, executability audit, contract/binding
 * resolution, registration, the node handler and its data-flow
 * injection, the permission gate, deterministic evaluation, HITL
 * escalation, HITL resume — is the existing code, called unmodified.
 *
 * ## Execution guarantees (filesystem level; NOT exactly-once)
 *
 *   - A step that reached a terminal state (`succeeded`, `failed`,
 *     `rejected`) is never executed again by normal continuation: the
 *     next segment starts at the first `pending`/`interrupted` step.
 *   - A step persisted as `running` whose process disappeared is
 *     recovered as `interrupted` (or, if its underlying `ExecutionRecord`
 *     was completed before the crash, its recorded outcome is ADOPTED —
 *     no re-execution). Only an EXPLICIT `resume` re-executes an
 *     `interrupted` step, under a NEW execution id (the old one is kept in
 *     `supersededExecutionIds`): at-least-once for that one in-flight
 *     step, and only on explicit request — there are no automatic retries.
 *   - `LocalFsBlobStore.put` is a plain `writeFile` (not write-to-temp +
 *     rename); a crash DURING a write can leave a truncated record, which
 *     reads back as corrupt (404). Best-effort, not transactional.
 */

const activeDrives = new Set<string>();

export interface WorkflowRunnerContext {
  readonly workspace: WorkspaceRecord;
  readonly compilationStore: CompilationStore;
  readonly approvalStore: ApprovalStore;
  readonly executionStore: ExecutionStore;
  readonly workflowStore: WorkflowExecutionStore;
}

/** Test/inspection hook: is this process currently driving this workflow execution? */
export function isWorkflowBeingDriven(workflowExecutionId: string): boolean {
  return activeDrives.has(workflowExecutionId);
}

// ---------------------------------------------------------------------------
// Persistence helper — the only place `revision` is bumped.
// ---------------------------------------------------------------------------

class RecordHolder {
  constructor(
    private readonly store: WorkflowExecutionStore,
    private held: WorkflowExecutionRecord,
  ) {}

  get current(): WorkflowExecutionRecord {
    return this.held;
  }

  /** Applies `fn` and persists the result with compare-and-swap on `revision`. A stale revision throws `StaleWorkflowRevisionError` (a 409 `WorkflowConflictError`) and leaves the stored record untouched. */
  async update(fn: (record: WorkflowExecutionRecord, now: string) => WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
    const previous = this.held;
    const now = new Date().toISOString();
    const next: WorkflowExecutionRecord = { ...fn(previous, now), revision: previous.revision + 1, updatedAt: now };
    const saved = await this.store.save(next, previous.revision);
    if (!saved.ok) throw saved.error;
    this.held = saved.value;
    return saved.value;
  }
}

// ---------------------------------------------------------------------------
// Resolution of the authoritative runtime pieces for one workflow
// ---------------------------------------------------------------------------

interface WorkflowRuntime {
  readonly compilation: CompilationRecord;
  readonly graph: XoirGraph;
  /** `XoirGraph.contentHash()` of the graph AS LOADED from the compilation store — captured before `lowerCapabilitiesToManifest` (which embeds contracts, i.e. mutates the graph) runs below, so it is the same value the runtime registration in `resolveWorkflow` already reported on every execution receipt. For a graph persisted by `compile-source.ts` (already lowered), lowering is idempotent and this equals the graph's manifest `graphHash`. */
  readonly graphHash: string;
  readonly resolved: ResolvedWorkflow;
  /** `contractId` -> that capability's manifest-level input schema (`lowerCapabilitiesToManifest`, the same call P0.5's `executeApprovedCapability` makes), when it has one. */
  readonly inputSchemas: ReadonlyMap<string, CapabilityInputSchema>;
  /** `capabilityId` -> input names a PROVEN upstream binding supplies at run time (the bridge's `wiredInjections`). Those values come from an authoritative producer output, not from the client, so they are excluded from client-input schema validation. */
  readonly injectedInputNames: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Re-derives everything authoritative about a workflow from the STORED
 * compilation — never from the client, never from a fresh compile. Called
 * at start AND at every continuation, so contract/binding resolution and
 * the executability verdict are re-checked each time work resumes.
 */
async function loadWorkflowRuntime(ctx: WorkflowRunnerContext, compilationId: string, workflowId: string): Promise<Result<WorkflowRuntime, XoError>> {
  const compilation = await ctx.compilationStore.get(compilationId);
  if (!compilation.ok) return err(compilation.error);
  if (compilation.value.status !== 'succeeded') {
    return err(new XoError(ErrorCode.INVALID_ARGUMENT, `compilation "${compilationId}" has status "${compilation.value.status}" — only a succeeded compilation can be executed against`));
  }
  const graphJson = await ctx.compilationStore.getCompiledGraph(compilationId);
  if (!graphJson.ok) return err(graphJson.error);

  const composed = composeCompilationWorkflows(graphJson.value, compilation.value.completedAt ?? compilation.value.createdAt);
  if (!composed.ok) return err(composed.error);
  const workflow = findWorkflow(composed.value, workflowId);
  if (workflow === undefined) return err(new NotFoundError(`workflow "${workflowId}" in compilation "${compilationId}"`));

  const graphHash = composed.value.graph.contentHash();
  const resolved = resolveWorkflow(composed.value.graph, workflow);

  const inputSchemas = new Map<string, CapabilityInputSchema>();
  const lowered = lowerCapabilitiesToManifest(composed.value.graph);
  for (const outcome of lowered.outcomes) {
    const schema = outcome.declaration?.execution?.inputSchema;
    if (schema !== undefined) inputSchemas.set(outcome.contractId, schema);
  }
  const injectedInputNames = new Map<string, Set<string>>();
  for (const binding of resolved.prepared.wiredInjections) {
    const names = injectedInputNames.get(binding.consumerCapabilityId) ?? new Set<string>();
    names.add(binding.inputParameterName);
    injectedInputNames.set(binding.consumerCapabilityId, names);
  }
  return ok({ compilation: compilation.value, graph: composed.value.graph, graphHash, resolved, inputSchemas, injectedInputNames });
}

// ---------------------------------------------------------------------------
// Authorization — at start (preflight, all steps) and before EVERY step
// ---------------------------------------------------------------------------

/**
 * Fail-closed authorization for one step: (1) the capability must be
 * approved in this workspace (P0.5's `ApprovalStore`, re-read every time —
 * never cached), and (2) every non-optional permission requirement the
 * step's contract registered must resolve to `allow` under the SAME
 * `PermissionManager` + empty `RuleBasedPolicy` pattern P0.5/P0.7 use
 * (empty policy => deny). `RuntimeCapabilityExecutor.execute` then checks
 * (2) again itself; this pre-check exists so a denial is reported BEFORE
 * any execution record or state is created at start time.
 */
async function authorizeStep(ctx: WorkflowRunnerContext, runtime: WorkflowRuntime, permissionManager: PermissionManager, step: { readonly capabilityId: string; readonly contractId: string | undefined }): Promise<{ readonly code: string; readonly message: string } | undefined> {
  const approval = await ctx.approvalStore.get(runtime.compilation.compilationId, step.capabilityId);
  if (!approval.ok) return { code: approval.error.code, message: approval.error.message };
  if (!isApproved(approval.value)) {
    return { code: ErrorCode.RUNTIME_PERMISSION_DENIED, message: `capability "${step.capabilityId}" is not approved for execution in workspace "${ctx.workspace.workspaceId}"` };
  }
  if (step.contractId !== undefined) {
    for (const requirement of runtime.resolved.registry.permissions.resolve(step.contractId)) {
      const decision = await permissionManager.check({
        permission: requirement.permission,
        ...(requirement.scope !== undefined ? { scope: requirement.scope } : {}),
        requester: { packageId: NATIVE_CAPABILITY_REQUESTER, capabilityId: step.contractId },
      });
      if (decision.effect !== 'allow' && requirement.optional !== true) {
        return { code: ErrorCode.RUNTIME_PERMISSION_DENIED, message: `permission "${requirement.permission}" required by capability "${step.capabilityId}" was not granted: ${decision.reason}` };
      }
    }
  }
  return undefined;
}

function newPermissionManager(): PermissionManager {
  return new PermissionManager({ policy: new RuleBasedPolicy([]) });
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/** A payload field is delivered to a step iff that step's declared input schema names it (the schema is the authoritative statement of what the step accepts — `validateCapabilityInput` rejects anything else). A step with NO declared schema (today: every HITL step) receives the whole payload, exactly as P0.5's single-capability route passes the caller's input. No mapping is inferred from names or prose. */
function restrictInput(payload: Readonly<Record<string, unknown>>, schema: CapabilityInputSchema | undefined): Record<string, unknown> {
  if (schema === undefined) return { ...payload };
  const restricted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) if (key in schema.properties) restricted[key] = value;
  return restricted;
}

/** Start-time validation of the workflow payload against every step's declared schema — reusing `validateCapabilityInput` verbatim. A field the workflow-level payload carries that NO step could ever receive is rejected rather than silently dropped. Inputs a proven data-flow binding will supply at run time are not required from the client. */
function preflightInput(payload: Readonly<Record<string, unknown>>, runtime: WorkflowRuntime): string[] {
  const problems: string[] = [];
  const steps = runtime.resolved.prepared.steps;
  const schemas = steps.map((s) => (s.contractId !== undefined ? runtime.inputSchemas.get(s.contractId) : undefined));
  const anySchemaless = schemas.some((s) => s === undefined);
  if (!anySchemaless) {
    const declared = new Set(schemas.flatMap((s) => Object.keys(s!.properties)));
    for (const key of Object.keys(payload)) if (!declared.has(key)) problems.push(`input.${key}: not declared by any step of this workflow`);
  }
  steps.forEach((step, i) => {
    const schema = schemas[i];
    if (schema === undefined) return;
    const validation = validateCapabilityInput(schema, restrictInput(payload, schema));
    if (validation.valid) return;
    const injected = runtime.injectedInputNames.get(step.capabilityId) ?? new Set<string>();
    for (const issue of validation.issues) {
      if (injected.has(issue.property)) continue; // supplied by a proven upstream binding at run time
      problems.push(`step ${i} ("${step.capabilityName}") input.${issue.property}: ${issue.message}`);
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------
// The per-step wrapper around RuntimeCapabilityExecutor (composition, not subclassing)
// ---------------------------------------------------------------------------

interface StepBinding {
  readonly index: number;
  readonly capabilityId: string;
  readonly contractId: string;
  readonly bindingId?: string;
  readonly executionClass?: 'deterministic_rule' | 'human_in_the_loop';
}

/**
 * Wraps one real `RuntimeCapabilityExecutor` instance. For each
 * `execute()` call it: re-checks authorization; creates the step's
 * P0.5 `ExecutionRecord` and persists the step as `running`; validates
 * the FINAL input (payload subset + any injected upstream value) against
 * the step's schema; delegates the actual execution to the real
 * executor; completes the `ExecutionRecord`; and persists the step's
 * outcome. It contains no capability semantics of its own.
 *
 * Any exception (a store failure, a stale-revision conflict) is caught,
 * stashed in `fatal`, and surfaced to the engine as an error result —
 * an exception thrown inside a node handler would otherwise leave
 * `WorkflowExecutor`'s per-node promise unsettled. The driver rethrows
 * `fatal` once the engine returns.
 */
class RecordingStepExecutor {
  fatal: unknown;

  constructor(
    private readonly ctx: WorkflowRunnerContext,
    private readonly runtime: WorkflowRuntime,
    private readonly inner: RuntimeCapabilityExecutor,
    private readonly permissionManager: PermissionManager,
    private readonly holder: RecordHolder,
    private readonly stepsByContractId: ReadonlyMap<string, StepBinding>,
  ) {}

  async execute(request: RuntimeCapabilityExecutionRequest): Promise<Result<RuntimeCapabilityExecutionResult, RuntimeError>> {
    try {
      return await this.executeRecorded(request);
    } catch (cause) {
      this.fatal = cause;
      return err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `workflow step bookkeeping failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  }

  private async executeRecorded(request: RuntimeCapabilityExecutionRequest): Promise<Result<RuntimeCapabilityExecutionResult, RuntimeError>> {
    const step = this.stepsByContractId.get(request.capabilityId);
    if (step === undefined) return err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND, `capability "${request.capabilityId}" is not a step of this workflow`));

    // Sequential-only guard: exactly one step may be in flight, and it must be the one the record says is next.
    const expectedIndex = firstRunnableStepIndex(this.holder.current);
    if (expectedIndex !== step.index) {
      return err(new RuntimeError(ErrorCode.RUNTIME_SESSION_INVALID_STATE, `step ${step.index} may not run: the next runnable step of this workflow is ${expectedIndex}`));
    }

    const workspace = this.ctx.workspace;
    const created = await this.ctx.executionStore.create(workspace.workspaceId, workspace.identityId, { compilationId: this.runtime.compilation.compilationId, capabilityId: step.capabilityId, input: request.input });
    if (!created.ok) throw created.error;
    const executionId = created.value.executionId;

    await this.holder.update((r, now) =>
      withStepStarted(r, step.index, { executionId, contractId: step.contractId, ...(step.bindingId !== undefined ? { bindingId: step.bindingId } : {}), ...(step.executionClass !== undefined ? { executionClass: step.executionClass } : {}) }, now),
    );

    const denial = await authorizeStep(this.ctx, this.runtime, this.permissionManager, { capabilityId: step.capabilityId, contractId: step.contractId });
    if (denial !== undefined) return this.recordFailure(step, executionId, denial.code, denial.message);

    const schema = this.runtime.inputSchemas.get(step.contractId);
    if (schema !== undefined) {
      // Validate what the CLIENT supplied. A value injected by a proven upstream binding is authoritative producer output and is not part of the client-input schema (which is derived from the rule's own fields).
      const injected = this.runtime.injectedInputNames.get(step.capabilityId);
      const clientInput = Object.fromEntries(Object.entries((request.input ?? {}) as Record<string, unknown>).filter(([key]) => !injected?.has(key)));
      const validation = validateCapabilityInput(schema, clientInput);
      if (!validation.valid) {
        return this.recordFailure(step, executionId, ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID, `input validation failed: ${validation.issues.map((i) => `${i.property}: ${i.message}`).join('; ')}`);
      }
    }

    // The one real execution — unmodified RuntimeCapabilityExecutor (confidence gate, permission gate, registry resolution, deterministic evaluate / HITL escalation).
    const result = await this.inner.execute(request);
    if (!result.ok) return this.recordFailure(step, executionId, result.error.code, result.error.message, result.error);

    const output = result.value.output;
    const isEscalation = typeof output === 'object' && output !== null && (output as Record<string, unknown>)['status'] === 'escalation_required';
    const shared = {
      output,
      ...(result.value.contractId !== undefined ? { contractId: result.value.contractId } : {}),
      ...(result.value.bindingId !== undefined ? { bindingId: result.value.bindingId } : {}),
      ...(result.value.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: result.value.sourceXoirNodeIds } : {}),
      ...(result.value.graphHash !== undefined ? { graphHash: result.value.graphHash } : {}),
      ...(result.value.contractContentHash !== undefined ? { contractContentHash: result.value.contractContentHash } : {}),
    };
    const outcomeInput: ExecutionOutcomeInput = isEscalation ? { status: 'waiting_for_human', ...shared } : { status: 'succeeded', ...shared };
    const completed = await this.ctx.executionStore.complete(executionId, outcomeInput);
    if (!completed.ok) throw completed.error;

    const outcome: StepOutcome = isEscalation ? { kind: 'waiting_for_human' } : { kind: 'succeeded', output, ...(result.value.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: result.value.sourceXoirNodeIds } : {}) };
    await this.holder.update((r, now) => withStepOutcome(r, step.index, outcome, now));
    return result;
  }

  private async recordFailure(step: StepBinding, executionId: string, code: string, message: string, original?: RuntimeError): Promise<Result<RuntimeCapabilityExecutionResult, RuntimeError>> {
    const completed = await this.ctx.executionStore.complete(executionId, { status: 'failed', errorCode: code, errorMessage: message });
    if (!completed.ok) throw completed.error;
    await this.holder.update((r, now) => withStepOutcome(r, step.index, { kind: 'failed', code, message }, now));
    if (original !== undefined) return err(original);
    const runtimeCode = code === ErrorCode.RUNTIME_PERMISSION_DENIED ? ErrorCode.RUNTIME_PERMISSION_DENIED : ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID;
    return err(new RuntimeError(runtimeCode, message));
  }
}

// ---------------------------------------------------------------------------
// The driver — runs segments until the workflow is waiting_for_human or terminal
// ---------------------------------------------------------------------------

function stepNodeId(order: number, capabilityId: string): NodeId {
  // Must match `prepareCandidateWorkflowForExecution`'s own node-id convention exactly.
  return NodeId(`step_${order}_${capabilityId}`);
}

function buildSegmentGraph(runtime: WorkflowRuntime, record: WorkflowExecutionRecord, startIndex: number, endIndex: number): WorkflowGraph {
  const full = runtime.resolved.prepared.graph;
  const nodes = [full.nodes.find((n) => n.id === full.startNodeId)!];
  const edges: { from: NodeId; to: NodeId }[] = [];
  let previous: NodeId = full.startNodeId;
  for (let i = startIndex; i <= endIndex; i++) {
    const stepState = record.steps[i]!;
    const id = stepNodeId(stepState.order, stepState.capabilityId);
    const node = full.nodes.find((n) => n.id === id);
    if (node === undefined) throw new XoError(ErrorCode.UNKNOWN, `internal error: prepared graph has no node for step ${i}`);
    const contractId = runtime.resolved.prepared.steps[i]?.contractId;
    const schema = contractId !== undefined ? runtime.inputSchemas.get(contractId) : undefined;
    nodes.push({ ...node, config: { ...(node.config ?? {}), structuredInput: restrictInput(record.input, schema) } });
    edges.push({ from: previous, to: id });
    previous = id;
  }
  const endNode = full.nodes.find((n) => n.type === 'end')!;
  nodes.push(endNode);
  edges.push({ from: previous, to: endNode.id });
  return { graphId: `${full.graphId}:segment:${startIndex}-${endIndex}`, version: full.version, nodes, edges, startNodeId: full.startNodeId };
}

/** Seeds the engine's own `WorkflowState.outputs` with the persisted outputs of already-succeeded deterministic steps, in the exact shape `makeCapabilityAuthorityNodeHandler` writes and reads (`{..., result}`), so the bridge's unmodified proven-data-flow injection finds an upstream producer's value across segments/restarts. HITL outputs are never seeded: the bridge never injects from a HITL producer. */
function seedOutputs(runtime: WorkflowRuntime, record: WorkflowExecutionRecord, upTo: number): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (let i = 0; i < upTo; i++) {
    const step = record.steps[i]!;
    const bridge = runtime.resolved.prepared.steps[i];
    if (step.status !== 'succeeded' || bridge?.implementationClass !== 'deterministic_rule') continue;
    outputs[stepNodeId(step.order, step.capabilityId)] = { capabilityId: bridge.contractId ?? step.capabilityId, ...(step.contractId !== undefined ? { contractId: step.contractId } : {}), ...(step.bindingId !== undefined ? { bindingId: step.bindingId } : {}), result: step.result };
  }
  return outputs;
}

async function driveWorkflow(ctx: WorkflowRunnerContext, holder: RecordHolder, runtime: WorkflowRuntime): Promise<void> {
  const prepared = runtime.resolved.prepared;
  const permissionManager = newPermissionManager();

  // The persisted step list must still be exactly the workflow the compilation composes — fail closed otherwise.
  const rec0 = holder.current;
  const mismatch = rec0.steps.length !== prepared.steps.length || rec0.steps.some((s, i) => s.capabilityId !== prepared.steps[i]?.capabilityId);
  if (mismatch) {
    await holder.update((r, now) => withWorkflowFailure(r, ErrorCode.WORKFLOW_NOT_EXECUTABLE, 'persisted workflow steps no longer match the workflow composed from the stored compilation', now));
    return;
  }

  await holder.update((r, now) => withRunning(r, now));

  const stepsByContractId = new Map<string, StepBinding>();
  prepared.steps.forEach((s, i) => {
    if (s.contractId === undefined) return;
    stepsByContractId.set(s.contractId, { index: i, capabilityId: s.capabilityId, contractId: s.contractId, ...(s.bindingId !== undefined ? { bindingId: s.bindingId } : {}), ...(s.implementationClass === 'deterministic_rule' || s.implementationClass === 'human_in_the_loop' ? { executionClass: s.implementationClass } : {}) });
  });

  const environment: ExecutionEnvironment = { environmentId: EnvironmentId(`env_api_${holder.current.workflowExecutionId}`), hostProfile: { family: 'generic', capabilities: [] }, createdAt: new Date().toISOString() };
  const maxSegments = holder.current.steps.length + 1;

  for (let segment = 0; segment < maxSegments; segment++) {
    const record = holder.current;
    if (record.status !== 'running') return;
    const startIndex = firstRunnableStepIndex(record);
    if (startIndex < 0) return;
    if (record.steps.slice(0, startIndex).some((s) => s.status !== 'succeeded')) {
      await holder.update((r, now) => withWorkflowFailure(r, ErrorCode.RUNTIME_SESSION_INVALID_STATE, 'workflow state is inconsistent: an earlier step has not succeeded', now));
      return;
    }
    // The segment ends at the first HITL step (inclusive) or the last step.
    let endIndex = record.steps.length - 1;
    for (let i = startIndex; i < record.steps.length; i++) {
      if (prepared.steps[i]?.implementationClass === 'human_in_the_loop') {
        endIndex = i;
        break;
      }
    }

    const graph = buildSegmentGraph(runtime, record, startIndex, endIndex);
    const inner = new RuntimeCapabilityExecutor({ registry: runtime.resolved.registry, permissionManager });
    const recorder = new RecordingStepExecutor(ctx, runtime, inner, permissionManager, holder, stepsByContractId);
    // The wrapper is handed to the existing, unmodified `makeCapabilityAuthorityNodeHandler`, which only ever calls `.execute({capabilityId, input})`. That function's parameter is typed as the concrete class, whose private members make a structurally identical object non-assignable; the single cast below is the entire cost of composing instead of subclassing.
    const handler = makeCapabilityAuthorityNodeHandler(recorder as unknown as RuntimeCapabilityExecutor);
    const engine = new WorkflowExecutor(
      async () => {
        throw new Error('unreachable: this bridge graph contains no built-in "capability" nodes');
      },
      { customNodeHandlers: new Map([['custom:capability-authority', handler]]) },
    );

    const now = new Date();
    const instance: WorkflowInstance = Object.freeze({
      workflowInstanceId: WorkflowInstanceId(record.workflowExecutionId),
      graph,
      state: { ...createInitialState(() => now), outputs: seedOutputs(runtime, record, startIndex) },
      status: 'suspended' as const,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    const result = await engine.resume(createCheckpoint(instance), environment);

    if (recorder.fatal !== undefined) throw recorder.fatal;

    // A workflow that is still `running` here means the engine stopped without any step recording a failure (an engine-level error) — never claim success.
    if (holder.current.status === 'running' && result.error !== undefined) {
      const engineError = result.error;
      await holder.update((r, at) => withWorkflowFailure(r, engineError.code, engineError.message, at));
      return;
    }
  }
  if (holder.current.status === 'running') {
    await holder.update((r, now) => withWorkflowFailure(r, ErrorCode.UNKNOWN, 'workflow driver made no progress', now));
  }
}

// ---------------------------------------------------------------------------
// Recovery of a workflow whose driving process is gone
// ---------------------------------------------------------------------------

/**
 * Called (under the workflow's lock) for a record persisted as
 * `created`/`running` that this process is NOT driving. If the running
 * step's `ExecutionRecord` was completed before the crash, its recorded
 * outcome is adopted (no re-execution); otherwise the step is marked
 * `interrupted`. A completed human-task execution is adopted as
 * `waiting_for_human` (the resume route handles its resolution).
 */
async function recoverStale(ctx: WorkflowRunnerContext, record: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
  const holder = new RecordHolder(ctx.workflowStore, record);
  const runningIndex = record.steps.findIndex((s) => s.status === 'running');
  if (runningIndex >= 0) {
    const step = record.steps[runningIndex]!;
    const found = step.executionId !== undefined ? await ctx.executionStore.get(step.executionId) : undefined;
    if (found?.ok === true && found.value.completedAt !== undefined) {
      const exec = found.value;
      let outcome: StepOutcome | undefined;
      if (exec.humanTask !== undefined) outcome = { kind: 'waiting_for_human' };
      else if (exec.status === 'succeeded') outcome = { kind: 'succeeded', output: exec.output, ...(exec.sourceXoirNodeIds !== undefined ? { sourceXoirNodeIds: exec.sourceXoirNodeIds } : {}) };
      else if (exec.status === 'failed') outcome = { kind: 'failed', code: exec.errorCode ?? ErrorCode.UNKNOWN, message: exec.errorMessage ?? 'step failed' };
      if (outcome !== undefined) {
        const adopted = outcome;
        await holder.update((r, now) => withStepOutcome(r, runningIndex, adopted, now));
      }
    }
  }
  if (holder.current.status === 'created' || holder.current.status === 'running') {
    await holder.update((r) => withInterrupted(r));
  }
  return holder.current;
}

async function reconcileIfStale(ctx: WorkflowRunnerContext, record: WorkflowExecutionRecord): Promise<WorkflowExecutionRecord> {
  if ((record.status !== 'created' && record.status !== 'running') || activeDrives.has(record.workflowExecutionId)) return record;
  return withExecutionLock(record.workflowExecutionId, async () => {
    const fresh = await ctx.workflowStore.get(record.workflowExecutionId);
    if (!fresh.ok) throw fresh.error;
    // Re-checked inside the lock: a drive may have started (and even finished) while this call queued.
    if ((fresh.value.status !== 'created' && fresh.value.status !== 'running') || activeDrives.has(record.workflowExecutionId)) return fresh.value;
    return recoverStale(ctx, fresh.value);
  });
}

// ---------------------------------------------------------------------------
// Public operations (called by routes/workflow-routes.ts)
// ---------------------------------------------------------------------------

export interface StartWorkflowRequest {
  readonly compilationId: string;
  readonly workflowId: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export async function startWorkflowExecution(ctx: WorkflowRunnerContext, request: StartWorkflowRequest): Promise<WorkflowExecutionRecord> {
  const loaded = await loadWorkflowRuntime(ctx, request.compilationId, request.workflowId);
  if (!loaded.ok) throw loaded.error;
  const runtime = loaded.value;

  // Only `executable_candidate` workflows whose every step binds may start — statuses are never upgraded.
  if (!runtime.resolved.executable) throw workflowNotExecutableError(request.workflowId, request.compilationId, runtime.resolved);

  // Authorization preflight for EVERY step, before anything is persisted.
  const preflightManager = newPermissionManager();
  const denials: string[] = [];
  for (const step of runtime.resolved.prepared.steps) {
    const denial = await authorizeStep(ctx, runtime, preflightManager, { capabilityId: step.capabilityId, contractId: step.contractId });
    if (denial !== undefined) denials.push(denial.message);
  }
  if (denials.length > 0) throw new XoError(ErrorCode.RUNTIME_PERMISSION_DENIED, denials[0]!, { context: { denials } });

  const problems = preflightInput(request.input, runtime);
  if (problems.length > 0) throw new XoError(ErrorCode.INVALID_ARGUMENT, `workflow input validation failed: ${problems.join('; ')}`, { context: { issues: problems } });

  const workflowExecutionId = mintWorkflowExecutionId();
  activeDrives.add(workflowExecutionId);
  try {
    const created = await ctx.workflowStore.create(ctx.workspace.workspaceId, ctx.workspace.identityId, {
      workflowExecutionId,
      compilationId: request.compilationId,
      workflowId: request.workflowId,
      workflowName: runtime.resolved.workflow.name,
      input: request.input,
      steps: runtime.resolved.workflow.steps.map((s) => ({ stepId: s.id, order: s.order, capabilityId: s.capabilityId, capabilityName: s.capabilityName })),
      sourceId: runtime.compilation.sourceId,
      sourceDigestSha256: runtime.compilation.sourceDigestSha256,
      // The identity of the graph as loaded for this workflow — the same
      // `XoirGraph.contentHash()` value every step's execution receipt
      // reports (see `WorkflowRuntime.graphHash`).
      graphHash: runtime.graphHash,
    });
    if (!created.ok) throw created.error;
    const holder = new RecordHolder(ctx.workflowStore, created.value);
    await withExecutionLock(workflowExecutionId, () => driveWorkflow(ctx, holder, runtime));
    return holder.current;
  } finally {
    activeDrives.delete(workflowExecutionId);
  }
}

export interface ResumeWorkflowRequest {
  readonly decision?: HumanTaskDecision;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly expectedStepExecutionId?: string;
  readonly expectedRevision?: number;
}

export interface WorkflowExecutionView extends Omit<WorkflowExecutionRecord, 'pendingHumanTask'> {
  /** Live view of the pending human task: `humanTaskStatus` is read through from the step's underlying execution record, so a task resolved directly via P0.7's `POST /executions/:id/resolve` is visible here (continue it with a decision-less `resume`). */
  readonly pendingHumanTask?: { readonly stepIndex: number; readonly executionId: string; readonly humanTaskStatus: 'pending' | 'resolved' };
}

export async function toWorkflowExecutionView(ctx: WorkflowRunnerContext, record: WorkflowExecutionRecord): Promise<WorkflowExecutionView> {
  const { pendingHumanTask, ...rest } = record;
  if (pendingHumanTask === undefined) return rest;
  const exec = await ctx.executionStore.get(pendingHumanTask.executionId);
  const humanTaskStatus = exec.ok && exec.value.humanTask?.status === 'resolved' ? 'resolved' : 'pending';
  return { ...rest, pendingHumanTask: { ...pendingHumanTask, humanTaskStatus } };
}

export async function getWorkflowExecution(ctx: WorkflowRunnerContext, workflowExecutionId: string): Promise<WorkflowExecutionRecord> {
  const found = await ctx.workflowStore.get(workflowExecutionId);
  if (!found.ok) throw found.error;
  return reconcileIfStale(ctx, found.value);
}

export async function listWorkflowExecutions(ctx: WorkflowRunnerContext): Promise<readonly WorkflowExecutionRecord[]> {
  const listed = await ctx.workflowStore.list();
  if (!listed.ok) throw listed.error;
  return Promise.all(listed.value.map((r) => reconcileIfStale(ctx, r)));
}

function conflictContext(record: WorkflowExecutionRecord): Record<string, unknown> {
  return { workflowExecutionId: record.workflowExecutionId, status: record.status, revision: record.revision };
}

/**
 * `POST .../workflow-executions/:id/resume`. Everything below runs inside
 * the workflow's `withExecutionLock`, so two concurrent resumes are
 * serialized: the second observes whatever state the first left and is
 * refused deterministically (terminal / wrong step / stale revision /
 * no pending task) — it can never continue or re-execute anything the
 * first already did.
 */
export async function resumeWorkflowExecution(ctx: WorkflowRunnerContext, workflowExecutionId: string, request: ResumeWorkflowRequest): Promise<WorkflowExecutionRecord> {
  return withExecutionLock(workflowExecutionId, async () => {
    const found = await ctx.workflowStore.get(workflowExecutionId);
    if (!found.ok) throw found.error;
    let record = found.value;

    if (TERMINAL_WORKFLOW_STATUSES.has(record.status)) {
      throw new WorkflowConflictError(`workflow execution "${workflowExecutionId}" is already ${record.status}; there is nothing to resume`, 'terminal', conflictContext(record));
    }
    if (request.expectedRevision !== undefined && request.expectedRevision !== record.revision) {
      throw new WorkflowConflictError(`workflow execution "${workflowExecutionId}" is at revision ${record.revision}, not the expected ${request.expectedRevision}`, 'stale_revision', { ...conflictContext(record), expectedRevision: request.expectedRevision });
    }
    if (activeDrives.has(workflowExecutionId)) {
      throw new WorkflowConflictError(`workflow execution "${workflowExecutionId}" is currently being executed by this process`, 'in_flight', conflictContext(record));
    }

    if (record.status === 'created' || record.status === 'running') record = await recoverStale(ctx, record);
    // Recovery may have adopted a completed outcome and reached a terminal state.
    if (TERMINAL_WORKFLOW_STATUSES.has(record.status)) {
      throw new WorkflowConflictError(`workflow execution "${workflowExecutionId}" is already ${record.status}; there is nothing to resume`, 'terminal', conflictContext(record));
    }

    const holder = new RecordHolder(ctx.workflowStore, record);

    if (record.status === 'waiting_for_human') {
      const pending = record.pendingHumanTask;
      if (pending === undefined) throw new WorkflowConflictError(`workflow execution "${workflowExecutionId}" is waiting_for_human but records no pending human task`, 'not_resumable', conflictContext(record));

      // Decision 4: mandatory for a multi-step workflow, optional (P0.7-compatible) for a single-step one.
      if (record.steps.length > 1 && request.expectedStepExecutionId === undefined) {
        throw new XoError(ErrorCode.INVALID_ARGUMENT, '"expectedStepExecutionId" is required to resume a multi-step workflow that has a pending human-in-the-loop step', { context: { reason: 'expected_step_execution_id_required', workflowExecutionId } });
      }
      if (request.expectedStepExecutionId !== undefined && request.expectedStepExecutionId !== pending.executionId) {
        throw new WorkflowConflictError(`"expectedStepExecutionId" does not match the workflow's pending human task; the decision was NOT applied`, 'stale_step_execution', { ...conflictContext(record), expectedStepExecutionId: request.expectedStepExecutionId });
      }

      const execFound = await ctx.executionStore.get(pending.executionId);
      if (!execFound.ok) throw execFound.error;
      let exec: ExecutionRecord = execFound.value;

      if (exec.humanTask?.status === 'pending') {
        if (request.decision === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, '"decision" is required: the pending human task has not been resolved yet', { context: { reason: 'decision_required', workflowExecutionId } });
        const outcome = await resolveHumanTaskExecution(ctx.executionStore, ctx.compilationStore, pending.executionId, request.decision, request.data, ctx.workspace.identityId);
        switch (outcome.kind) {
          case 'not_found':
            throw outcome.error;
          case 'error':
            throw outcome.error;
          case 'not_a_human_task':
            throw new WorkflowConflictError(`execution "${pending.executionId}" is not a human task`, 'not_resumable', conflictContext(record));
          case 'already_resolved':
            throw new WorkflowConflictError(`human task "${pending.executionId}" was resolved concurrently by another request`, 'stale_step_execution', conflictContext(record));
          case 'resolved':
            exec = outcome.record;
        }
      } else if (request.decision !== undefined) {
        // Already resolved (e.g. directly via P0.7's /resolve): a conflicting/duplicate decision must never be applied or silently ignored.
        throw new WorkflowConflictError(`human task "${pending.executionId}" is already resolved; resume without a decision to continue the workflow`, 'not_resumable', conflictContext(record));
      }

      await holder.update((r, now) => withHumanResolution(r, pending.stepIndex, exec, now));
    } else if (record.status === 'interrupted') {
      if (request.decision !== undefined || request.data !== undefined) {
        throw new XoError(ErrorCode.INVALID_ARGUMENT, 'this workflow has no pending human task; do not supply "decision"/"data" when resuming an interrupted workflow', { context: { reason: 'no_pending_human_task', workflowExecutionId } });
      }
      if (request.expectedStepExecutionId !== undefined) {
        throw new WorkflowConflictError('this workflow has no pending human task, so "expectedStepExecutionId" cannot match', 'stale_step_execution', conflictContext(record));
      }
      // fall through to the drive below: the interrupted step is re-executed under a NEW execution id (explicit recovery).
    }

    if (holder.current.status === 'waiting_for_human' || TERMINAL_WORKFLOW_STATUSES.has(holder.current.status)) return holder.current;

    // Continue from the first runnable step. Re-resolves the authoritative workflow from the stored compilation.
    activeDrives.add(workflowExecutionId);
    try {
      const loaded = await loadWorkflowRuntime(ctx, holder.current.compilationId, holder.current.workflowId);
      if (!loaded.ok) {
        const failure = loaded.error;
        await holder.update((r, now) => withWorkflowFailure(r, failure.code, failure.message, now));
        return holder.current;
      }
      if (!loaded.value.resolved.executable) {
        const notExecutable = workflowNotExecutableError(holder.current.workflowId, holder.current.compilationId, loaded.value.resolved);
        await holder.update((r, now) => withWorkflowFailure(r, notExecutable.code, notExecutable.message, now));
        return holder.current;
      }
      await driveWorkflow(ctx, holder, loaded.value);
      return holder.current;
    } finally {
      activeDrives.delete(workflowExecutionId);
    }
  });
}
