/**
 * Pure styling-hook state for execution visualization: active / completed /
 * failed / pending nodes, the traversed execution path, and which edges
 * should render as animated. This module has zero knowledge of the XO
 * runtime — callers (e.g. a runtime debugger UI) translate their own
 * execution events into calls on this class.
 */
export class GraphExecutionState {
    statusByNode;
    path;
    animatedEdgeIds;
    constructor(statusByNode = new Map(), path = [], animatedEdgeIds = new Set()) {
        this.statusByNode = statusByNode;
        this.path = path;
        this.animatedEdgeIds = animatedEdgeIds;
    }
    static idle() {
        return new GraphExecutionState();
    }
    statusOf(nodeId) {
        return this.statusByNode.get(nodeId) ?? 'pending';
    }
    setStatus(nodeId, status) {
        const next = new Map(this.statusByNode);
        next.set(nodeId, status);
        const path = status === 'active' && this.path[this.path.length - 1] !== nodeId ? [...this.path, nodeId] : this.path;
        return new GraphExecutionState(next, path, this.animatedEdgeIds);
    }
    markActive(nodeId) {
        return this.setStatus(nodeId, 'active');
    }
    markCompleted(nodeId) {
        return this.setStatus(nodeId, 'completed');
    }
    markFailed(nodeId) {
        return this.setStatus(nodeId, 'failed');
    }
    animateEdge(edgeId) {
        return new GraphExecutionState(this.statusByNode, this.path, new Set([...this.animatedEdgeIds, edgeId]));
    }
    stopAnimatingEdge(edgeId) {
        const next = new Set(this.animatedEdgeIds);
        next.delete(edgeId);
        return new GraphExecutionState(this.statusByNode, this.path, next);
    }
    reset() {
        return GraphExecutionState.idle();
    }
}
//# sourceMappingURL=GraphExecutionState.js.map