import type { WorkflowGraph } from './workflow-graph.js';
import type { WorkflowState } from './workflow-state.js';
import type { WorkflowInstanceId } from '../ids.js';
export type WorkflowInstanceStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'suspended';
/**
 * One execution of a `WorkflowGraph` — the workflow-level analogue of
 * Stage 2's `ExecutionSession`. `'suspended'` is the status a checkpoint
 * captures: the instance stopped making progress not because it reached
 * a terminal outcome, but because a caller checkpointed it for later
 * `resume()`. Immutable: `WorkflowExecutor` produces a new
 * `WorkflowInstance` at every round, never mutates one in place.
 */
export interface WorkflowInstance {
    readonly workflowInstanceId: WorkflowInstanceId;
    readonly graph: WorkflowGraph;
    readonly state: WorkflowState;
    readonly status: WorkflowInstanceStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
}
//# sourceMappingURL=workflow-instance.d.ts.map