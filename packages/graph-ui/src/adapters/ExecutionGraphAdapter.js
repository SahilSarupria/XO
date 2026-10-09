import { GraphModel } from '../model/GraphModel.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
/** Converts a runtime-debugger-style execution graph into a generic GraphModel. */
export const ExecutionGraphAdapter = {
    kind: 'execution-graph',
    toGraphModel(source) {
        const nodes = source.nodes.map((n) => ({
            id: n.id,
            type: n.kind ?? 'task',
            label: n.label,
            position: { x: 0, y: 0 },
            ...(n.metadata !== undefined ? { metadata: n.metadata } : {}),
        }));
        const edges = source.edges.map((e) => ({
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
export function executionStateFromSource(source) {
    let state = GraphExecutionState.idle();
    if (!source.statuses)
        return state;
    for (const [nodeId, status] of Object.entries(source.statuses)) {
        state = state.setStatus(nodeId, status);
    }
    return state;
}
//# sourceMappingURL=ExecutionGraphAdapter.js.map