import type { EdgeId, ExecutionNodeStatus, NodeId } from '../model/types.js';

/**
 * Pure styling-hook state for execution visualization: active / completed /
 * failed / pending nodes, the traversed execution path, and which edges
 * should render as animated. This module has zero knowledge of the XO
 * runtime — callers (e.g. a runtime debugger UI) translate their own
 * execution events into calls on this class.
 */
export class GraphExecutionState {
  readonly statusByNode: ReadonlyMap<NodeId, ExecutionNodeStatus>;
  readonly path: readonly NodeId[];
  readonly animatedEdgeIds: ReadonlySet<EdgeId>;

  constructor(
    statusByNode: ReadonlyMap<NodeId, ExecutionNodeStatus> = new Map(),
    path: readonly NodeId[] = [],
    animatedEdgeIds: ReadonlySet<EdgeId> = new Set(),
  ) {
    this.statusByNode = statusByNode;
    this.path = path;
    this.animatedEdgeIds = animatedEdgeIds;
  }

  static idle(): GraphExecutionState {
    return new GraphExecutionState();
  }

  statusOf(nodeId: NodeId): ExecutionNodeStatus {
    return this.statusByNode.get(nodeId) ?? 'pending';
  }

  setStatus(nodeId: NodeId, status: ExecutionNodeStatus): GraphExecutionState {
    const next = new Map(this.statusByNode);
    next.set(nodeId, status);
    const path = status === 'active' && this.path[this.path.length - 1] !== nodeId ? [...this.path, nodeId] : this.path;
    return new GraphExecutionState(next, path, this.animatedEdgeIds);
  }

  markActive(nodeId: NodeId): GraphExecutionState {
    return this.setStatus(nodeId, 'active');
  }

  markCompleted(nodeId: NodeId): GraphExecutionState {
    return this.setStatus(nodeId, 'completed');
  }

  markFailed(nodeId: NodeId): GraphExecutionState {
    return this.setStatus(nodeId, 'failed');
  }

  animateEdge(edgeId: EdgeId): GraphExecutionState {
    return new GraphExecutionState(this.statusByNode, this.path, new Set([...this.animatedEdgeIds, edgeId]));
  }

  stopAnimatingEdge(edgeId: EdgeId): GraphExecutionState {
    const next = new Set(this.animatedEdgeIds);
    next.delete(edgeId);
    return new GraphExecutionState(this.statusByNode, this.path, next);
  }

  reset(): GraphExecutionState {
    return GraphExecutionState.idle();
  }
}
