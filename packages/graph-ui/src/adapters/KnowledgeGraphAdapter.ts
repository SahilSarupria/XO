import { GraphModel } from '../model/GraphModel.js';
import type { GraphEdge, GraphMetadata, GraphNode } from '../model/types.js';
import type { GraphAdapter } from './types.js';

export interface KnowledgeGraphEntity {
  readonly id: string;
  readonly label: string;
  readonly kind?: 'entity' | 'concept';
  readonly metadata?: GraphMetadata;
}

export interface KnowledgeGraphRelation {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly type?: string;
  readonly metadata?: GraphMetadata;
}

export interface KnowledgeGraphSource {
  readonly entities: readonly KnowledgeGraphEntity[];
  readonly relations: readonly KnowledgeGraphRelation[];
}

/** Converts an entity/relation knowledge graph into a generic GraphModel. */
export const KnowledgeGraphAdapter: GraphAdapter<KnowledgeGraphSource> = {
  kind: 'knowledge-graph',
  toGraphModel(source: KnowledgeGraphSource): GraphModel {
    const nodes: GraphNode[] = source.entities.map((e) => ({
      id: e.id,
      type: e.kind ?? 'entity',
      label: e.label,
      position: { x: 0, y: 0 },
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    }));
    const edges: GraphEdge[] = source.relations.map((r) => ({
      id: r.id,
      type: r.type ?? 'relates_to',
      source: r.from,
      target: r.to,
      ...(r.label !== undefined ? { label: r.label } : {}),
      ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
    }));
    return GraphModel.empty().upsertNodes(nodes).upsertEdges(edges);
  },
};
