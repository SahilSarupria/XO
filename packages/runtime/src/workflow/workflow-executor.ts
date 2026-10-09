import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import type { ExecutionEnvironment, ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { WorkflowInstanceId } from '../ids.js';
import type { RuntimeStore } from '../persistence/runtime-store.interface.js';
import { workflowScope } from '../memory/memory-types.js';
import type { RuntimeMemory } from '../memory/runtime-memory.js';
import { CheckpointStore, createCheckpoint, type WorkflowCheckpoint } from './workflow-checkpoint.js';
import type { WorkflowContext } from './workflow-context.js';
import type { WorkflowEdge, WorkflowGraph, NodeId, RetryPolicy } from './workflow-graph.js';
import { WorkflowEventEmitter, type WorkflowEvent } from './workflow-events.js';
import type { WorkflowInstance, WorkflowInstanceStatus } from './workflow-instance.js';
import { builtinNodeHandlers, type NodeHandler, type NodeHandlerResult } from './workflow-node-handlers.js';
import { buildWorkflowReceipt, type WorkflowNodeReceipt, type WorkflowResult } from './workflow-receipt.js';
import { WorkflowScheduler } from './workflow-scheduler.js';
import { createInitialState, edgeKey, type WorkflowHistoryEntry, type WorkflowState } from './workflow-state.js';

export interface WorkflowExecutorOptions {
  /** Handlers for `custom:<name>` node types — a node whose type has no built-in handler and no matching entry here fails with `RUNTIME_INVALID_REQUEST`, rather than being silently skipped. */
  readonly customNodeHandlers?: ReadonlyMap<string, NodeHandler>;
  readonly events?: WorkflowEventEmitter;
  readonly instrumentation?: RuntimeInstrumentation;
  readonly logger?: Logger;
  readonly now?: () => Date;
  /** Overridable for tests — real delay by default (`setTimeout`), an instant-resolving stand-in in tests that exercise `delay` nodes or retry backoff without actually waiting. Always resolves early if `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly checkpointStore?: CheckpointStore;
  /** When `true`, a checkpoint is created after every round (see "Checkpointing" in the README) — off by default, since most callers only want to checkpoint explicitly or on a slower cadence than every single round. */
  readonly checkpointEveryRound?: boolean;
  /**
   * Stage 4. Optional — omitted, this executor behaves exactly as Stage
   * 3 always did (nothing durable, not even in-memory beyond the
   * existing `checkpointStore`). Set, every top-level `run()`/`resume()`
   * persists its execution record after each round and at completion,
   * every `createCheckpoint`-during-`checkpointEveryRound` call also
   * durably persists, and every produced receipt is saved. Nested
   * executions (`loop`/`subworkflow` bodies) are never separately
   * persisted — see `runNested`'s doc comment.
   */
  readonly store?: RuntimeStore;
  /**
   * Stage 5. Optional — omitted, `WorkflowContext.memory` is absent for
   * every node, exactly matching every pre-Stage-5 `WorkflowContext`
   * consumer's expectations (no behavior change). Set, every
   * `WorkflowContext` this executor builds carries a `memory` scoped to
   * this run's `workflow` scope (`workflowScope(workflowInstanceId)`) —
   * see `WorkflowContext`'s doc comment and the Runtime README's Stage 5
   * section for the full memory model.
   */
  readonly runtimeMemory?: RuntimeMemory;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function computeBackoffMs(policy: RetryPolicy | undefined, attempt: number): number {
  if (!policy) return 0;
  const multiplier = policy.backoffMultiplier ?? 1;
  // Deterministic: attempt-indexed, no jitter, per Stage 3's "no randomness" constraint.
  return Math.round(policy.backoffMs * multiplier ** (attempt - 1));
}

interface DispatchOutcome {
  readonly status: 'completed' | 'failed';
  readonly attempts: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly result?: NodeHandlerResult;
  readonly error?: RuntimeError;
}

/**
 * Runs a `WorkflowGraph` to completion — Stage 3's core engine. Built
 * entirely on top of Stage 1/2 without modifying either: `capability`
 * nodes delegate to Stage 2's `ExecutionPipeline.run` unchanged (see
 * `workflow-node-handlers.ts`'s `makeCapabilityNodeHandler`), and
 * cancellation reuses Stage 2's `ExecutionCancellation` directly.
 *
 * The round loop is the whole algorithm: compute the deterministic
 * cursor (`WorkflowScheduler.computeCursor`), resolve every `toSkip`
 * node, dispatch every `ready` node concurrently (each through its own
 * retry/timeout handling), fold the results into a new immutable
 * `WorkflowState`, repeat until nothing is ready or waiting. No node
 * type gets special scheduling treatment beyond what its `NodeHandler`
 * does — see `workflow-scheduler.ts`'s doc comment for why that's
 * possible.
 */
export class WorkflowExecutor {
  private readonly scheduler = new WorkflowScheduler();
  private readonly handlers: ReadonlyMap<string, NodeHandler>;
  private readonly customHandlers: ReadonlyMap<string, NodeHandler>;
  private readonly events: WorkflowEventEmitter;
  private readonly instrumentation: RuntimeInstrumentation | undefined;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly checkpointStore: CheckpointStore;
  private readonly checkpointEveryRound: boolean;
  private readonly store: RuntimeStore | undefined;
  private readonly runtimeMemory: RuntimeMemory | undefined;

  constructor(
    private readonly runCapability: (request: ExecutionRequest, cancellation: ExecutionCancellation) => Promise<ExecutionResult>,
    options: WorkflowExecutorOptions = {},
  ) {
    this.customHandlers = options.customNodeHandlers ?? new Map();
    this.events = options.events ?? new WorkflowEventEmitter();
    this.instrumentation = options.instrumentation;
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.checkpointStore = options.checkpointStore ?? new CheckpointStore(this.now);
    this.checkpointEveryRound = options.checkpointEveryRound ?? false;
    this.store = options.store;
    this.runtimeMemory = options.runtimeMemory;

    this.handlers = builtinNodeHandlers({
      scheduler: { outgoingEdges: (graph, nodeId) => this.scheduler.outgoingEdges(graph, nodeId) },
      runCapability: (request, cancellation) => this.runCapability(request, cancellation),
      runNestedGraph: (graph, context, outputs) => this.runNested(graph, context, outputs),
      sleep: this.sleep,
    });
  }

  get eventEmitter(): WorkflowEventEmitter {
    return this.events;
  }

  async run(graph: WorkflowGraph, environment: ExecutionEnvironment, cancellation: ExecutionCancellation = new ExecutionCancellation()): Promise<WorkflowResult> {
    const instance: WorkflowInstance = Object.freeze({
      workflowInstanceId: WorkflowInstanceId(`wf_${graph.graphId}_${this.now().getTime()}`),
      graph,
      state: createInitialState(this.now),
      status: 'pending' as const,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    });
    this.emit('started', instance);
    return this.runToCompletion(instance, environment, cancellation, true);
  }

  async resume(checkpoint: WorkflowCheckpoint, environment: ExecutionEnvironment, cancellation: ExecutionCancellation = new ExecutionCancellation()): Promise<WorkflowResult> {
    this.emit('resumed', checkpoint.instance);
    return this.runToCompletion(checkpoint.instance, environment, cancellation, true);
  }

  /**
   * Stage 4 convenience built entirely on existing Stage 3 primitives —
   * no second resume implementation. Looks up the latest persisted
   * checkpoint for `executionId` in `this.store` and resumes from it
   * (via the exact same `resume()` above); if no checkpoint was ever
   * taken but the execution record itself was persisted (every round
   * persists one when a `store` is configured — see the class doc
   * comment), falls back to synthesizing a checkpoint from that record
   * with `createCheckpoint` (the same function `createCheckpoint()`
   * below uses) rather than requiring a checkpoint to have existed.
   * Fails clearly if neither exists — there is nothing to resume.
   */
  async resumeFromStore(executionId: WorkflowInstanceId, environment: ExecutionEnvironment, cancellation: ExecutionCancellation = new ExecutionCancellation()): Promise<Result<WorkflowResult, RuntimeError>> {
    if (!this.store) {
      return err(new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, 'resumeFromStore requires a store to be configured on this WorkflowExecutor'));
    }

    const latestCheckpoint = await this.store.checkpoints.latestForExecution(executionId);
    if (!latestCheckpoint.ok) return latestCheckpoint;
    if (latestCheckpoint.value) {
      return ok(await this.resume(latestCheckpoint.value.data.checkpoint, environment, cancellation));
    }

    const executionRecord = await this.store.executions.get(executionId);
    if (!executionRecord.ok) return executionRecord;
    if (executionRecord.value) {
      const checkpoint = createCheckpoint(executionRecord.value.data.instance, this.now);
      return ok(await this.resume(checkpoint, environment, cancellation));
    }

    return err(new RuntimeError(ErrorCode.RUNTIME_RETRIEVAL_FAILED, `No persisted execution or checkpoint found for "${executionId}"`));
  }

  createCheckpoint(instance: WorkflowInstance): WorkflowCheckpoint {
    const checkpoint = this.checkpointStore.create(instance);
    this.emit('checkpoint', instance, undefined, { checkpointId: checkpoint.checkpointId });
    return checkpoint;
  }

  /**
   * Stage 4. Same as `createCheckpoint`, plus — when a `store` is
   * configured — durably persisting the checkpoint. `createCheckpoint`
   * itself stays synchronous and unchanged (Stage 3 callers and tests
   * keep working exactly as before); this is a new, separate, opt-in
   * method for the durable case, not a replacement.
   */
  async persistCheckpoint(instance: WorkflowInstance): Promise<Result<WorkflowCheckpoint, RuntimeError>> {
    const checkpoint = this.createCheckpoint(instance);
    if (!this.store) return ok(checkpoint);
    const saved = await this.store.checkpoints.save(checkpoint);
    if (!saved.ok) return saved;
    return ok(checkpoint);
  }

  /** Persists the current execution record (a snapshot of `instance` plus the scheduler's derived `waitingNodeIds`) when a `store` is configured; a no-op returning success when it isn't. Never called for nested (`loop`/`subworkflow`) executions — see `runNested`. */
  private async persistExecution(instance: WorkflowInstance): Promise<Result<void, RuntimeError>> {
    if (!this.store) return ok(undefined);
    const waitingNodeIds = this.scheduler.computeCursor(instance.graph, instance.state).waiting;
    const saved = await this.store.executions.save({ executionId: instance.workflowInstanceId, instance, waitingNodeIds });
    if (!saved.ok) return saved;
    return ok(undefined);
  }

  /** Persists every produced receipt (the workflow's own, plus each `capability` node's Stage 2 receipt) when a `store` is configured. Only ever called once, on successful completion — a failed/cancelled run has no `WorkflowReceipt` to persist (see `buildWorkflowReceipt`'s callers). */
  private async persistReceipts(instance: WorkflowInstance, receipt: WorkflowResult['receipt']): Promise<Result<void, RuntimeError>> {
    if (!this.store || !receipt) return ok(undefined);
    const workflowSaved = await this.store.receipts.saveWorkflowReceipt(receipt);
    if (!workflowSaved.ok) return workflowSaved;
    for (const nodeReceipt of receipt.nodeReceipts) {
      const saved = await this.store.receipts.saveExecutionReceipt(instance.workflowInstanceId, nodeReceipt.receipt);
      if (!saved.ok) return saved;
    }
    return ok(undefined);
  }

  private async runToCompletion(startInstance: WorkflowInstance, environment: ExecutionEnvironment, cancellation: ExecutionCancellation, isTopLevel: boolean): Promise<WorkflowResult> {
    const startedAt = this.now().getTime();
    let instance = Object.freeze({ ...startInstance, status: 'running' as WorkflowInstanceStatus });
    const nodeReceipts: WorkflowNodeReceipt[] = [];

    if (isTopLevel) {
      const persisted = await this.persistExecution(instance);
      if (!persisted.ok) return this.terminate(instance, startedAt, persisted.error, isTopLevel);
    }

    while (true) {
      if (cancellation.isCancelled) {
        const status: WorkflowInstanceStatus = cancellation.reason === 'timeout' ? 'timed_out' : 'cancelled';
        instance = Object.freeze({ ...instance, status, updatedAt: this.now().toISOString() });
        this.emit('cancelled', instance);
        return this.terminate(instance, startedAt, new RuntimeError(status === 'timed_out' ? ErrorCode.RUNTIME_EXECUTION_TIMEOUT : ErrorCode.RUNTIME_EXECUTION_CANCELLED, `Workflow ${status}`), isTopLevel);
      }

      const cursor = this.scheduler.computeCursor(instance.graph, instance.state);
      if (cursor.ready.length === 0 && cursor.toSkip.length === 0) {
        if (cursor.waiting.length > 0) {
          instance = Object.freeze({ ...instance, status: 'failed', updatedAt: this.now().toISOString() });
          this.emit('failed', instance);
          return this.terminate(
            instance,
            startedAt,
            new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Workflow "${instance.graph.graphId}" stalled: ${cursor.waiting.length} node(s) never became reachable (${cursor.waiting.join(', ')})`),
            isTopLevel,
          );
        }
        break; // nothing ready, nothing to skip, nothing waiting: done
      }

      let state = instance.state;
      state = this.applySkips(state, cursor.toSkip, instance.graph);

      const context: WorkflowContext = this.buildContext(instance.workflowInstanceId, instance.graph, state, environment, cancellation);
      const dispatched = await Promise.all(cursor.ready.map((nodeId) => this.dispatchOne(instance.workflowInstanceId, instance.graph, nodeId, context)));

      for (let i = 0; i < cursor.ready.length; i++) {
        const nodeId = cursor.ready[i]!;
        const outcome = dispatched[i]!;
        // A node whose own dispatch failed specifically *because* the
        // workflow was cancelled (see `runWithTimeout`) is deliberately
        // NOT folded into `failedNodes` — a cancellation isn't the
        // node's own failure, and permanently recording it as failed
        // would make it ineligible for a future `resume()` to retry.
        // The node simply stays unvisited; the workflow-level status
        // becomes `'cancelled'` below, which is what actually matters.
        if (outcome.error?.code === ErrorCode.RUNTIME_EXECUTION_CANCELLED) continue;
        state = this.applyOutcome(state, instance.graph, nodeId, outcome);
        if (outcome.result?.nodeReceipts) nodeReceipts.push(...outcome.result.nodeReceipts);
      }

      instance = Object.freeze({ ...instance, state, updatedAt: this.now().toISOString() });

      // Stage 4: the "state updated" transition — every round's coherent,
      // resumable snapshot. Only for top-level executions; see
      // `runNested`'s doc comment for why a loop/subworkflow body's
      // internal rounds are never separately persisted.
      if (isTopLevel) {
        const persisted = await this.persistExecution(instance);
        if (!persisted.ok) return this.terminate(instance, startedAt, persisted.error, isTopLevel);
      }

      if (this.checkpointEveryRound) {
        const checkpointed = await this.persistCheckpoint(instance);
        if (!checkpointed.ok) return this.terminate(instance, startedAt, checkpointed.error, isTopLevel);
      }

      // Checked before `failedNodes`: a node whose dispatch raced against
      // cancellation (see `runWithTimeout`) surfaces as a node-level
      // failure, but the workflow-level outcome should still be
      // "cancelled", not "failed" — cancellation is the more accurate,
      // more actionable status for a caller to see.
      if (cancellation.isCancelled) {
        const status: WorkflowInstanceStatus = cancellation.reason === 'timeout' ? 'timed_out' : 'cancelled';
        instance = Object.freeze({ ...instance, status, updatedAt: this.now().toISOString() });
        this.emit('cancelled', instance);
        return this.terminate(instance, startedAt, new RuntimeError(status === 'timed_out' ? ErrorCode.RUNTIME_EXECUTION_TIMEOUT : ErrorCode.RUNTIME_EXECUTION_CANCELLED, `Workflow ${status}`), isTopLevel);
      }

      if (instance.state.failedNodes.length > 0) {
        instance = Object.freeze({ ...instance, status: 'failed' });
        this.emit('failed', instance);
        const firstFailure = dispatched.find((outcome) => outcome.status === 'failed' && outcome.error?.code !== ErrorCode.RUNTIME_EXECUTION_CANCELLED)?.error;
        return this.terminate(instance, startedAt, firstFailure ?? new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Workflow "${instance.graph.graphId}" failed: node(s) ${instance.state.failedNodes.join(', ')} exhausted retries`), isTopLevel);
      }
    }

    instance = Object.freeze({ ...instance, status: 'completed', updatedAt: this.now().toISOString() });
    this.emit('completed', instance);
    const receipt = buildWorkflowReceipt({ instance, nodeReceipts, durationMs: this.now().getTime() - startedAt, now: this.now });

    if (isTopLevel) {
      const persistedExecution = await this.persistExecution(instance);
      if (!persistedExecution.ok) return this.terminate(instance, startedAt, persistedExecution.error, isTopLevel);
      const persistedReceipts = await this.persistReceipts(instance, receipt);
      if (!persistedReceipts.ok) return this.terminate(instance, startedAt, persistedReceipts.error, isTopLevel);
    }

    return { workflowInstanceId: instance.workflowInstanceId, instance, receipt };
  }

  /** Runs `graph` as a nested execution (for `loop`/`subworkflow`), seeded with `initialOutputs` merged into its starting state so the nested graph's conditions/capability inputs can see the outer context. Reuses the exact same round loop as a top-level `run()`, just without its own checkpoint/event-`started` semantics (the outer run already owns those). */
  private async runNested(
    graph: WorkflowGraph,
    outerContext: WorkflowContext,
    initialOutputs: Readonly<Record<string, unknown>>,
  ): Promise<Result<{ outputs: Readonly<Record<string, unknown>>; nodeReceipts: readonly WorkflowNodeReceipt[]; resourceUsage: NodeHandlerResult['resourceUsage'] }, RuntimeError>> {
    const seeded: WorkflowState = { ...createInitialState(this.now), outputs: initialOutputs };
    const nestedInstance: WorkflowInstance = Object.freeze({
      workflowInstanceId: WorkflowInstanceId(`${outerContext.workflowInstanceId}::${graph.graphId}_${this.now().getTime()}`),
      graph,
      state: seeded,
      status: 'running' as const,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    });

    const result = await this.runToCompletion(nestedInstance, outerContext.environment, outerContext.cancellation, false);
    if (result.error || !result.receipt) {
      return err(result.error ?? new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Nested workflow "${graph.graphId}" did not complete`));
    }
    return ok({
      outputs: result.instance.state.outputs,
      nodeReceipts: result.receipt.nodeReceipts,
      resourceUsage: { promptTokens: result.receipt.resourceUsage.promptTokens, completionTokens: result.receipt.resourceUsage.completionTokens, estimatedCost: result.receipt.resourceUsage.estimatedCost },
    });
  }

  /**
   * Stage 5. Builds one round's `WorkflowContext`, attaching `memory`
   * (scoped to this execution's `workflow` scope) only when this
   * executor was constructed with a `runtimeMemory` — see
   * `WorkflowExecutorOptions.runtimeMemory`'s doc comment. This is the
   * *only* place a `WorkflowContext` is constructed anywhere in this
   * class (both the top-level round loop and `runNested`'s body run
   * through `runToCompletion`, which calls this), so nested executions
   * see the same `memory` scoping as their parent — a `loop`/`subworkflow`
   * body's `workflowInstanceId` is its own instance's, not the parent's,
   * so its `memory` is correctly its own `workflow` scope, isolated from
   * the parent's (§16's isolation invariant applies across nesting too).
   */
  private buildContext(workflowInstanceId: WorkflowInstanceId, graph: WorkflowGraph, state: WorkflowState, environment: ExecutionEnvironment, cancellation: ExecutionCancellation): WorkflowContext {
    return {
      workflowInstanceId,
      graph,
      state,
      environment,
      cancellation,
      ...(this.runtimeMemory ? { memory: this.runtimeMemory.forScope(workflowScope(workflowInstanceId)) } : {}),
    };
  }

  private async dispatchOne(workflowInstanceId: WorkflowInstanceId, graph: WorkflowGraph, nodeId: NodeId, context: WorkflowContext): Promise<DispatchOutcome> {
    const node = this.scheduler.nodeById(graph, nodeId);
    if (!node) {
      const timestamp = this.now().toISOString();
      return { status: 'failed', attempts: 0, startedAt: timestamp, completedAt: timestamp, durationMs: 0, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Unknown node "${nodeId}"`) };
    }
    const handler = this.handlers.get(node.type) ?? this.customHandlers.get(node.type);
    if (!handler) {
      const timestamp = this.now().toISOString();
      return { status: 'failed', attempts: 0, startedAt: timestamp, completedAt: timestamp, durationMs: 0, error: new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, `No handler registered for node type "${node.type}" (node "${node.id}")`) };
    }

    this.emitNode('node_started', workflowInstanceId, nodeId);
    const maxAttempts = node.retryPolicy?.maxAttempts ?? 1;
    let lastError: RuntimeError | undefined;
    const overallStartedAt = this.now();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (context.cancellation.isCancelled) {
        return { status: 'failed', attempts: attempt, startedAt: overallStartedAt.toISOString(), completedAt: this.now().toISOString(), durationMs: 0, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_CANCELLED, `Node "${node.id}" cancelled`) };
      }
      const attemptStartedAt = this.now().getTime();
      const outcome = await this.runWithTimeout(handler(node, context), node.timeoutMs, context.cancellation);
      const durationMs = this.now().getTime() - attemptStartedAt;

      if (outcome.ok) {
        this.instrumentation?.recordExecutionOutcome('node_completed', durationMs, { nodeType: node.type, attempts: attempt });
        this.emitNode('node_completed', workflowInstanceId, nodeId, { attempts: attempt });
        return { status: 'completed', attempts: attempt, startedAt: overallStartedAt.toISOString(), completedAt: this.now().toISOString(), durationMs: this.now().getTime() - overallStartedAt.getTime(), result: outcome.value };
      }

      lastError = outcome.error;
      if (attempt < maxAttempts) {
        this.logger.warn('workflow node attempt failed, retrying', { nodeId, attempt, maxAttempts, error: outcome.error.message });
        await this.sleep(computeBackoffMs(node.retryPolicy, attempt), context.cancellation.signal);
      }
    }

    this.instrumentation?.recordExecutionOutcome('node_failed', 0, { nodeType: node.type, attempts: maxAttempts });
    this.emitNode('node_failed', workflowInstanceId, nodeId, { attempts: maxAttempts, error: lastError?.message });
    return { status: 'failed', attempts: maxAttempts, startedAt: overallStartedAt.toISOString(), completedAt: this.now().toISOString(), durationMs: 0, ...(lastError ? { error: lastError } : {}) };
  }

  private async runWithTimeout(promise: Promise<Result<NodeHandlerResult, RuntimeError>>, timeoutMs: number | undefined, cancellation: ExecutionCancellation): Promise<Result<NodeHandlerResult, RuntimeError>> {
    // Always races against cancellation, not just when a timeout is set —
    // otherwise a node with no `timeoutMs` (the common case) could run to
    // completion ignoring an in-flight cancel/timeout entirely, which
    // would be a real correctness gap given `ExecutionCancellation` is
    // the mechanism the whole rest of the runtime relies on.
    return new Promise((resolve) => {
      let settled = false;
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              resolve(err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_TIMEOUT, `Node timed out after ${timeoutMs}ms`)));
            }, timeoutMs)
          : undefined;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_CANCELLED, 'Node cancelled')));
      };
      cancellation.signal.addEventListener('abort', onAbort, { once: true });
      promise.then((result) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        cancellation.signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
    });
  }

  private applySkips(state: WorkflowState, toSkip: readonly NodeId[], graph: WorkflowGraph): WorkflowState {
    if (toSkip.length === 0) return state;
    const timestamp = this.now().toISOString();
    const newHistory: WorkflowHistoryEntry[] = toSkip.map((nodeId) => ({ nodeId, status: 'skipped' as const, attempt: 0, startedAt: timestamp, completedAt: timestamp, durationMs: 0 }));
    // A skipped node's own outgoing edges are all "taken" in the sense
    // that the skip propagates forward — its successors should see it
    // the same way they'd see any other terminal predecessor.
    const propagatedEdgeKeys = toSkip.flatMap((nodeId) => this.scheduler.outgoingEdges(graph, nodeId).map((edge) => edgeKey(edge.from, edge.to)));
    return Object.freeze({
      ...state,
      skippedNodes: [...state.skippedNodes, ...toSkip],
      history: [...state.history, ...newHistory],
      takenEdges: [...state.takenEdges, ...propagatedEdgeKeys],
      updatedAt: timestamp,
    });
  }

  private applyOutcome(state: WorkflowState, graph: WorkflowGraph, nodeId: NodeId, outcome: DispatchOutcome): WorkflowState {
    const historyEntry: WorkflowHistoryEntry = {
      nodeId,
      status: outcome.status === 'completed' ? 'completed' : 'failed',
      attempt: outcome.attempts,
      startedAt: outcome.startedAt,
      completedAt: outcome.completedAt,
      durationMs: outcome.durationMs,
      ...(outcome.error ? { error: outcome.error.message } : {}),
    };

    if (outcome.status === 'failed') {
      return Object.freeze({ ...state, failedNodes: [...state.failedNodes, nodeId], history: [...state.history, historyEntry], updatedAt: this.now().toISOString() });
    }

    const result = outcome.result ?? {};
    const takenEdges = result.takenEdges ?? this.scheduler.outgoingEdges(graph, nodeId);
    const outputs = result.output !== undefined ? { ...state.outputs, [nodeId]: result.output } : state.outputs;
    const usage = result.resourceUsage;
    const resourceUsage = usage
      ? {
          promptTokens: state.resourceUsage.promptTokens + (usage.promptTokens ?? 0),
          completionTokens: state.resourceUsage.completionTokens + (usage.completionTokens ?? 0),
          estimatedCost: state.resourceUsage.estimatedCost + (usage.estimatedCost ?? 0),
        }
      : state.resourceUsage;

    return Object.freeze({
      ...state,
      completedNodes: [...state.completedNodes, nodeId],
      history: [...state.history, historyEntry],
      outputs,
      takenEdges: [...state.takenEdges, ...takenEdges.map((edge: WorkflowEdge) => edgeKey(edge.from, edge.to))],
      resourceUsage,
      updatedAt: this.now().toISOString(),
    });
  }

  /**
   * Stage 4: also best-effort persists the terminal instance state
   * (failed/cancelled/timed-out/stalled) when a `store` is configured
   * and this is a top-level execution — so a caller who resumes later
   * sees the correct final status rather than the last mid-run snapshot.
   * If *this* persist itself fails, it's swallowed (logged, not
   * returned as a second error) rather than recursing back into
   * `terminate` again — the original error is always what's reported.
   */
  private async terminate(instance: WorkflowInstance, startedAt: number, error: RuntimeError, isTopLevel: boolean): Promise<WorkflowResult> {
    this.instrumentation?.recordExecutionOutcome(instance.status, this.now().getTime() - startedAt, { graphId: instance.graph.graphId });
    if (isTopLevel && this.store) {
      const persisted = await this.persistExecution(instance);
      if (!persisted.ok) this.logger.warn('failed to persist terminal execution state', { executionId: instance.workflowInstanceId, error: persisted.error.message });
    }
    return { workflowInstanceId: instance.workflowInstanceId, instance, error };
  }

  private emit(type: WorkflowEvent['type'], instance: WorkflowInstance, nodeId?: NodeId, data?: Readonly<Record<string, unknown>>): void {
    this.events.emit({
      type,
      workflowInstanceId: instance.workflowInstanceId,
      ...(nodeId ? { nodeId } : {}),
      timestamp: this.now().toISOString(),
      ...(data ? { data } : {}),
    });
  }

  private emitNode(type: WorkflowEvent['type'], workflowInstanceId: WorkflowInstanceId, nodeId: NodeId, data?: Readonly<Record<string, unknown>>): void {
    this.events.emit({
      type,
      workflowInstanceId,
      nodeId,
      timestamp: this.now().toISOString(),
      ...(data ? { data } : {}),
    });
  }
}
