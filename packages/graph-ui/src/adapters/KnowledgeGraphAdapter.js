import { GraphModel } from '../model/GraphModel.js';
/** Converts an entity/relation knowledge graph into a generic GraphModel. */
export const KnowledgeGraphAdapter = {
    kind: 'knowledge-graph',
    toGraphModel(source) {
        const nodes = source.entities.map((e) => ({
            id: e.id,
            type: e.kind ?? 'entity',
            label: e.label,
            position: { x: 0, y: 0 },
            ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
        }));
        const edges = source.relations.map((r) => ({
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
//# sourceMappingURL=KnowledgeGraphAdapter.js.map