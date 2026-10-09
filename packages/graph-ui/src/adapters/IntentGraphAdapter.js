import { GraphModel } from '../model/GraphModel.js';
/** Converts intents-with-slots into a generic GraphModel. */
export const IntentGraphAdapter = {
    kind: 'intent-graph',
    toGraphModel(source) {
        const intentNodes = source.intents.map((i) => ({
            id: i.id,
            type: 'intent',
            label: i.label,
            position: { x: 0, y: 0 },
            ...(i.metadata !== undefined ? { metadata: i.metadata } : {}),
        }));
        const slotNodes = source.slots.map((s) => ({
            id: s.id,
            type: 'slot',
            label: s.label,
            position: { x: 0, y: 0 },
            groupId: s.intentId,
            ...(s.metadata !== undefined ? { metadata: s.metadata } : {}),
        }));
        const edges = source.slots.map((s) => ({
            id: `${s.intentId}->${s.id}`,
            type: s.required ? 'required_slot' : 'optional_slot',
            source: s.intentId,
            target: s.id,
        }));
        return GraphModel.empty().upsertNodes(intentNodes).upsertNodes(slotNodes).upsertEdges(edges);
    },
};
//# sourceMappingURL=IntentGraphAdapter.js.map