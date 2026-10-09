import type { EdgeId, ExecutionNodeStatus, NodeId } from '../model/types.js';
/**
 * Pure styling-hook state for execution visualization: active / completed /
 * failed / pending nodes, the traversed execution path, and which edges
 * should render as animated. This module has zero knowledge of the XO
 * runtime — callers (e.g. a runtime debugger UI) translate their own
 * execution events into calls on this class.
 */
export declare class GraphExecutionState {
    readonly statusByNode: ReadonlyMap<NodeId, ExecutionNodeStatus>;
    readonly path: readonly NodeId[];
    readonly animatedEdgeIds: ReadonlySet<EdgeId>;
    constructor(statusByNode?: ReadonlyMap<NodeId, ExecutionNodeStatus>, path?: readonly NodeId[], animatedEdgeIds?: ReadonlySet<EdgeId>);
    static idle(): GraphExecutionState;
    statusOf(nodeId: NodeId): ExecutionNodeStatus;
    setStatus(nodeId: NodeId, status: ExecutionNodeStatus): GraphExecutionState;
    markActive(nodeId: NodeId): GraphExecutionState;
    markCompleted(nodeId: NodeId): GraphExecutionState;
    markFailed(nodeId: NodeId): GraphExecutionState;
    animateEdge(edgeId: EdgeId): GraphExecutionState;
    stopAnimatingEdge(edgeId: EdgeId): GraphExecutionState;
    reset(): GraphExecutionState;
}
//# sourceMappingURL=GraphExecutionState.d.ts.map