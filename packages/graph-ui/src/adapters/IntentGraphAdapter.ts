import { GraphModel } from '../model/GraphModel.js';
import type { GraphEdge, GraphMetadata, GraphNode } from '../model/types.js';
import type { GraphAdapter } from './types.js';

export interface IntentGraphIntent {
  readonly id: string;
  readonly label: string;
  readonly metadata?: GraphMetadata;
}

export interface IntentGraphSlot {
  readonly id: string;
  readonly label: string;
  readonly intentId: string;
  readonly required?: boolean;
  readonly metadata?: GraphMetadata;
}

export interface IntentGraphSource {
  readonly intents: readonly IntentGraphIntent[];
  readonly slots: readonly IntentGraphSlot[];
}

/** Converts intents-with-slots into a generic GraphModel. */
export const IntentGraphAdapter: GraphAdapter<IntentGraphSource> = {
  kind: 'intent-graph',
  toGraphModel(source: IntentGraphSource): GraphModel {
    const intentNodes: GraphNode[] = source.intents.map((i) => ({
      id: i.id,
      type: 'intent',
      label: i.label,
      position: { x: 0, y: 0 },
      ...(i.metadata !== undefined ? { metadata: i.metadata } : {}),
    }));
    const slotNodes: GraphNode[] = source.slots.map((s) => ({
      id: s.id,
      type: 'slot',
      label: s.label,
      position: { x: 0, y: 0 },
      groupId: s.intentId,
      ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
    }));
    const edges: GraphEdge[] = source.slots.map((s) => ({
      id: `${s.intentId}->${s.id}`,
      type: s.required ? 'required_slot' : 'optional_slot',
      source: s.intentId,
      target: s.id,
    }));
    return GraphModel.empty().upsertNodes(intentNodes).upsertNodes(slotNodes).upsertEdges(edges);
  },
};
