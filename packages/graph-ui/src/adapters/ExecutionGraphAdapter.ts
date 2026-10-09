import { GraphModel } from '../model/GraphModel.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
import type { ExecutionNodeStatus, GraphEdge, GraphMetadata, GraphNode } from '../model/types.js';
import type { GraphAdapter } from './types.js';

export interface ExecutionGraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly metadata?: GraphMetadata;
}

export interface ExecutionGraphEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly metadata?: GraphMetadata;
}

export interface ExecutionGraphSource {
  readonly nodes: readonly ExecutionGraphNode[];
  readonly edges: readonly ExecutionGraphEdge[];
  /** Optional initial per-node execution status, e.g. from a runtime
   * snapshot. graph-ui only consumes this as plain data — it never reaches
   * into the runtime itself. */
  readonly statuses?: Readonly<Record<string, ExecutionNodeStatus>>;
}

/** Converts a runtime-debugger-style execution graph into a generic GraphModel. */
export const ExecutionGraphAdapter: GraphAdapter<ExecutionGraphSource> = {
  kind: 'execution-graph',
  toGraphModel(source: ExecutionGraphSource): GraphModel {
    const nodes: GraphNode[] = source.nodes.map((n) => ({
      id: n.id,
      type: n.kind ?? 'task',
      label: n.label,
      position: { x: 0, y: 0 },
      ...(n.metadata !== undefined ? { metadata: n.metadata } : {}),
    }));
    const edges: GraphEdge[] = source.edges.map((e) => ({
      id: e.id,
      type: 'next',
      source: e.from,
      target: e.to,
      ...(e.label !== undefined ? { label: e.label } : {}),
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    }));
    return GraphModel.empty().upsertNodes(nodes).upsertEdges(edges);
  },
};

/** Builds the initial GraphExecutionState implied by a source's `statuses` map. */
export function executionStateFromSource(source: ExecutionGraphSource): GraphExecutionState {
  let state = GraphExecutionState.idle();
  if (!source.statuses) return state;
  for (const [nodeId, status] of Object.entries(source.statuses)) {
    state = state.setStatus(nodeId, status);
  }
  return state;
}
