import { GraphModel } from '../model/GraphModel.js';
import type { GraphEdge, GraphMetadata, GraphNode } from '../model/types.js';
import type { GraphAdapter } from './types.js';

export interface CapabilityGraphCapability {
  readonly id: string;
  readonly label: string;
  readonly metadata?: GraphMetadata;
}

export interface CapabilityGraphAction {
  readonly id: string;
  readonly label: string;
  readonly capabilityId: string;
  readonly metadata?: GraphMetadata;
}

export interface CapabilityGraphSource {
  readonly capabilities: readonly CapabilityGraphCapability[];
  readonly actions: readonly CapabilityGraphAction[];
}

/** Converts capabilities-composed-of-actions into a generic GraphModel. */
export const CapabilityGraphAdapter: GraphAdapter<CapabilityGraphSource> = {
  kind: 'capability-graph',
  toGraphModel(source: CapabilityGraphSource): GraphModel {
    const capabilityNodes: GraphNode[] = source.capabilities.map((c) => ({
      id: c.id,
      type: 'capability',
      label: c.label,
      position: { x: 0, y: 0 },
      ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
    }));
    const actionNodes: GraphNode[] = source.actions.map((a) => ({
      id: a.id,
      type: 'action',
      label: a.label,
      position: { x: 0, y: 0 },
      groupId: a.capabilityId,
      ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
    }));
    const edges: GraphEdge[] = source.actions.map((a) => ({
      id: `${a.capabilityId}->${a.id}`,
      type: 'composed_of',
      source: a.capabilityId,
      target: a.id,
    }));
    return GraphModel.empty()
      .upsertNodes(capabilityNodes)
      .upsertNodes(actionNodes)
      .upsertEdges(edges);
  },
};
