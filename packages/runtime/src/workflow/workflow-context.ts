import type { ExecutionEnvironment } from '../execution/execution-request.js';
import type { ExecutionCancellation } from '../cancellation/execution-cancellation.js';
import type { ScopedRuntimeMemory } from '../memory/runtime-memory.js';
import type { WorkflowGraph } from './workflow-graph.js';
import type { WorkflowInstanceId } from '../ids.js';
import type { WorkflowState } from './workflow-state.js';

/**
 * What a `NodeHandler` receives to do its work — read-only access to the
 * graph and current state (for a `decision`/`loop` handler to evaluate
 * conditions against `state.outputs`), the shared `ExecutionEnvironment`
 * (reused from Stage 2 unmodified — same `HostProfile`/`provider`/
 * `tokenBudget` every `capability` node's synthetic request carries),
 * and the one `ExecutionCancellation` shared across the whole workflow
 * run (so cancelling a workflow cancels every node still in flight,
 * including nested `capability`/`subworkflow` executions).
 *
 * Stage 5: `memory`, when a `WorkflowExecutor` was constructed with a
 * `runtimeMemory` option, is a `ScopedRuntimeMemory` pre-bound to this
 * run's `workflow` scope (`workflowScope(workflowInstanceId)`, see
 * `memory/memory-types.ts`) — the `context.memory.get(...)`/`.put(...)`
 * shape §17 of the Stage 5 brief asks for. Absent (not a no-op stub)
 * when no `runtimeMemory` was configured, matching this codebase's
 * existing "optional means not applicable" convention, so a node handler
 * checking `context.memory` can tell "no memory configured" apart from
 * "memory configured but empty."
 */
export interface WorkflowContext {
  readonly workflowInstanceId: WorkflowInstanceId;
  readonly graph: WorkflowGraph;
  readonly state: WorkflowState;
  readonly environment: ExecutionEnvironment;
  readonly cancellation: ExecutionCancellation;
  readonly memory?: ScopedRuntimeMemory;
}
