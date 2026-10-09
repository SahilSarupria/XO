import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import type { ExecutionEnvironment, ExecutionRequest } from '../execution/execution-request.js';
import type { ExecutionResult } from '../execution/execution-result.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
import { WorkflowInstanceId } from '../ids.js';
import type { RuntimeStore } from '../persistence/runtime-store.interface.js';
import type { RuntimeMemory } from '../memory/runtime-memory.js';
import { CheckpointStore, type WorkflowCheckpoint } from './workflow-checkpoint.js';
import type { WorkflowGraph } from './workflow-graph.js';
import { WorkflowEventEmitter } from './workflow-events.js';
import type { WorkflowInstance } from './workflow-instance.js';
import { type NodeHandler } from './workflow-node-handlers.js';
import { type WorkflowResult } from './workflow-receipt.js';
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
export declare class WorkflowExecutor {
    private readonly runCapability;
    private readonly scheduler;
    private readonly handlers;
    private readonly customHandlers;
    private readonly events;
    private readonly instrumentation;
    private readonly logger;
    private readonly now;
    private readonly sleep;
    private readonly checkpointStore;
    private readonly checkpointEveryRound;
    private readonly store;
    private readonly runtimeMemory;
    constructor(runCapability: (request: ExecutionRequest, cancellation: ExecutionCancellation) => Promise<ExecutionResult>, options?: WorkflowExecutorOptions);
    get eventEmitter(): WorkflowEventEmitter;
    run(graph: WorkflowGraph, environment: ExecutionEnvironment, cancellation?: ExecutionCancellation): Promise<WorkflowResult>;
    resume(checkpoint: WorkflowCheckpoint, environment: ExecutionEnvironment, cancellation?: ExecutionCancellation): Promise<WorkflowResult>;
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
    resumeFromStore(executionId: WorkflowInstanceId, environment: ExecutionEnvironment, cancellation?: ExecutionCancellation): Promise<Result<WorkflowResult, RuntimeError>>;
    createCheckpoint(instance: WorkflowInstance): WorkflowCheckpoint;
    /**
     * Stage 4. Same as `createCheckpoint`, plus — when a `store` is
     * configured — durably persisting the checkpoint. `createCheckpoint`
     * itself stays synchronous and unchanged (Stage 3 callers and tests
     * keep working exactly as before); this is a new, separate, opt-in
     * method for the durable case, not a replacement.
     */
    persistCheckpoint(instance: WorkflowInstance): Promise<Result<WorkflowCheckpoint, RuntimeError>>;
    /** Persists the current execution record (a snapshot of `instance` plus the scheduler's derived `waitingNodeIds`) when a `store` is configured; a no-op returning success when it isn't. Never called for nested (`loop`/`subworkflow`) executions — see `runNested`. */
    private persistExecution;
    /** Persists every produced receipt (the workflow's own, plus each `capability` node's Stage 2 receipt) when a `store` is configured. Only ever called once, on successful completion — a failed/cancelled run has no `WorkflowReceipt` to persist (see `buildWorkflowReceipt`'s callers). */
    private persistReceipts;
    private runToCompletion;
    /** Runs `graph` as a nested execution (for `loop`/`subworkflow`), seeded with `initialOutputs` merged into its starting state so the nested graph's conditions/capability inputs can see the outer context. Reuses the exact same round loop as a top-level `run()`, just without its own checkpoint/event-`started` semantics (the outer run already owns those). */
    private runNested;
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
    private buildContext;
    private dispatchOne;
    private runWithTimeout;
    private applySkips;
    private applyOutcome;
    /**
     * Stage 4: also best-effort persists the terminal instance state
     * (failed/cancelled/timed-out/stalled) when a `store` is configured
     * and this is a top-level execution — so a caller who resumes later
     * sees the correct final status rather than the last mid-run snapshot.
     * If *this* persist itself fails, it's swallowed (logged, not
     * returned as a second error) rather than recursing back into
     * `terminate` again — the original error is always what's reported.
     */
    private terminate;
    private emit;
    private emitNode;
}
//# sourceMappingURL=workflow-executor.d.ts.map