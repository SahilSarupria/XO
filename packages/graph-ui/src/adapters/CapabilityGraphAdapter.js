import { GraphModel } from '../model/GraphModel.js';
/** Converts capabilities-composed-of-actions into a generic GraphModel. */
export const CapabilityGraphAdapter = {
    kind: 'capability-graph',
    toGraphModel(source) {
        const capabilityNodes = source.capabilities.map((c) => ({
            id: c.id,
            type: 'capability',
            label: c.label,
            position: { x: 0, y: 0 },
            ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
        }));
        const actionNodes = source.actions.map((a) => ({
            id: a.id,
            type: 'action',
            label: a.label,
            position: { x: 0, y: 0 },
            groupId: a.capabilityId,
            ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
        }));
        const edges = source.actions.map((a) => ({
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
//# sourceMappingURL=CapabilityGraphAdapter.js.map