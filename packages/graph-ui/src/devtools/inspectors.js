import { GraphDiagnostics } from '../diagnostics/GraphDiagnostics.js';
export function inspectGraph(model) {
    const nodeTypeCounts = {};
    for (const node of model.nodes)
        nodeTypeCounts[node.type] = (nodeTypeCounts[node.type] ?? 0) + 1;
    const edgeTypeCounts = {};
    for (const edge of model.edges)
        edgeTypeCounts[edge.type] = (edgeTypeCounts[edge.type] ?? 0) + 1;
    return { nodeCount: model.nodeCount, edgeCount: model.edgeCount, groupCount: model.nodeGroups.length, nodeTypeCounts, edgeTypeCounts };
}
export function inspectInteraction(drag, resize, hover, focus) {
    return { drag, resize, hover, focus };
}
export function inspectSelection(selection, sampleSize = 10) {
    return {
        nodeCount: selection.state.nodeIds.size,
        edgeCount: selection.state.edgeIds.size,
        groupCount: selection.state.groupIds.size,
        sampleNodeIds: [...selection.state.nodeIds].slice(0, sampleSize),
    };
}
export function inspectLayout(availableKinds, lastComputed) {
    return lastComputed !== undefined ? { availableKinds, lastComputed } : { availableKinds };
}
export function inspectCamera(camera) {
    return { viewport: camera.viewport.state, bookmarkNames: camera.bookmarkNames, canUndo: camera.canUndo, canRedo: camera.canRedo };
}
export function inspectPerformance(model, frame, activeLayoutKind) {
    const renderCost = GraphDiagnostics.estimateRenderCost(frame);
    const memory = GraphDiagnostics.estimateMemory(model);
    const recommendations = GraphDiagnostics.recommendations({
        nodeCount: model.nodeCount,
        edgeCount: model.edgeCount,
        ...(activeLayoutKind !== undefined ? { activeLayoutKind } : {}),
    });
    return { renderCost, memory, recommendations };
}
export function inspectAnimation(engine) {
    return { activeIds: engine.activeIds, count: engine.size };
}
export function inspectHistory(history) {
    return { canUndo: history.canUndo, canRedo: history.canRedo, pastLength: history.past.length, futureLength: history.future.length };
}
//# sourceMappingURL=inspectors.js.map