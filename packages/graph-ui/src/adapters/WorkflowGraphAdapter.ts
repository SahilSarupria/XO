import { GraphModel } from '../model/GraphModel.js';
import type { GraphEdge, GraphMetadata, GraphNode } from '../model/types.js';
import type { GraphAdapter } from './types.js';

export interface WorkflowGraphStep {
  readonly id: string;
  readonly label: string;
  readonly kind?: 'step' | 'decision';
  readonly metadata?: GraphMetadata;
}

export interface WorkflowGraphTransition {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly metadata?: GraphMetadata;
}

export interface WorkflowGraphSource {
  readonly steps: readonly WorkflowGraphStep[];
  readonly transitions: readonly WorkflowGraphTransition[];
}

/** Converts steps + transitions (with optional decision branches) into a generic GraphModel. */
export const WorkflowGraphAdapter: GraphAdapter<WorkflowGraphSource> = {
  kind: 'workflow-graph',
  toGraphModel(source: WorkflowGraphSource): GraphModel {
    const nodes: GraphNode[] = source.steps.map((s) => ({
      id: s.id,
      type: s.kind ?? 'step',
      label: s.label,
      position: { x: 0, y: 0 },
      ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
    }));
    const edges: GraphEdge[] = source.transitions.map((t) => ({
      id: t.id,
      type: 'transition',
      source: t.from,
      target: t.to,
      ...(t.label !== undefined ? { label: t.label } : {}),
      ...(t.metadata !== undefined ? { metadata: t.metadata } : {}),
    }));
    return GraphModel.empty().upsertNodes(nodes).upsertEdges(edges);
  },
};
