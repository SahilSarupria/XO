import type { NodeId, WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow-graph.js';
import type { WorkflowState } from './workflow-state.js';
/**
 * The deterministic execution frontier: which nodes are ready to
 * dispatch right now, and which are still waiting on incomplete
 * predecessors. Computed fresh from `WorkflowGraph` + `WorkflowState` on
 * every round — never itself mutated or cached across rounds, so it can
 * never drift from the state it was computed against.
 */
export interface WorkflowCursor {
    /** Nodes with every incoming edge's source already terminal (completed/failed/skipped) and at least one `completed` — ready to execute this round. Sorted by each node's index in `graph.nodes` (declaration order), never by `Map`/`Set` iteration or arrival order — see the module doc comment for why that matters. */
    readonly ready: readonly NodeId[];
    /** Nodes with every incoming edge's source terminal, but *none* `completed` (every live path into them was `skipped`) — resolve to `skipped` on the same round, without ever being dispatched to a handler. Same declaration-order sorting as `ready`. */
    readonly toSkip: readonly NodeId[];
    /** Everything else not yet visited: still has at least one incoming edge whose source hasn't reached a terminal state yet. */
    readonly waiting: readonly NodeId[];
}
/**
 * Deterministic scheduling for a directed `WorkflowGraph` — "execution
 * order must always be reproducible; no randomness; no dependency on
 * object iteration order." Every method here is a pure function of its
 * arguments; `WorkflowScheduler` itself holds no state.
 *
 * The one readiness rule below is deliberately generic rather than
 * special-cased per node type — it's what makes `sequence` (single
 * predecessor, must be completed), parallel fan-out (multiple
 * simultaneously-ready nodes, no special rule needed), an AND-join at an
 * explicit `merge` node (multiple predecessors, all must be terminal),
 * and an OR-join at an ordinary reconvergence node after a `decision`
 * (multiple predecessors, but only the taken branch actually completes —
 * the rest resolve to `skipped`) all fall out of the same rule, with
 * `merge`/`sequence` staying pure documentation/semantic markers rather
 * than scheduler-special-cased behavior. See `packages/runtime/README.md`'s
 * Stage 3 section for the full walkthrough with an example graph.
 */
export declare class WorkflowScheduler {
    computeCursor(graph: WorkflowGraph, state: WorkflowState): WorkflowCursor;
    /** Every outgoing edge of `node`, in `graph.edges`' declared order — the order `decision`/`loop` handlers evaluate conditions in. */
    outgoingEdges(graph: WorkflowGraph, nodeId: NodeId): readonly WorkflowEdge[];
    nodeById(graph: WorkflowGraph, nodeId: NodeId): WorkflowNode | undefined;
}
//# sourceMappingURL=workflow-scheduler.d.ts.map