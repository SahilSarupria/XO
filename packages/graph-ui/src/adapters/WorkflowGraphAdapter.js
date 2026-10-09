import { GraphModel } from '../model/GraphModel.js';
/** Converts steps + transitions (with optional decision branches) into a generic GraphModel. */
export const WorkflowGraphAdapter = {
    kind: 'workflow-graph',
    toGraphModel(source) {
        const nodes = source.steps.map((s) => ({
            id: s.id,
            type: s.kind ?? 'step',
            label: s.label,
            position: { x: 0, y: 0 },
            ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
        }));
        const edges = source.transitions.map((t) => ({
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
//# sourceMappingURL=WorkflowGraphAdapter.js.map