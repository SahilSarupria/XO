/** `` `${from}::${to}` `` — the edge-key format `WorkflowState.takenEdges` uses. Node ids are expected to be simple identifiers without `::` in them; see `WorkflowState.takenEdges`'s doc comment. */
export function edgeKey(from, to) {
    return `${from}::${to}`;
}
export const EMPTY_RESOURCE_USAGE = Object.freeze({ promptTokens: 0, completionTokens: 0, estimatedCost: 0 });
export function createInitialState(now) {
    const timestamp = now().toISOString();
    return Object.freeze({
        currentNodeIds: [],
        completedNodes: [],
        failedNodes: [],
        skippedNodes: [],
        outputs: {},
        history: [],
        takenEdges: [],
        loopIterations: {},
        resourceUsage: EMPTY_RESOURCE_USAGE,
        startedAt: timestamp,
        updatedAt: timestamp,
    });
}
//# sourceMappingURL=workflow-state.js.map