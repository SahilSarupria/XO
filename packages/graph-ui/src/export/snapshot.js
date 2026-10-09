import { GraphTheme } from '../theme/GraphTheme.js';
import { modelFromJsonObject, modelToJsonObject } from './toJson.js';
import { selectionStateToSnapshot } from './types.js';
/** Captures a full, JSON-serializable snapshot of a controller's current state. */
export function captureSnapshot(state, nowMs) {
    return {
        version: 1,
        capturedAtMs: nowMs,
        model: modelToJsonObject(state.model),
        viewport: state.viewport.state,
        selection: selectionStateToSnapshot(state.selection.state),
        theme: state.theme.definition,
    };
}
export function exportSnapshotToJson(snapshot, pretty = false) {
    return JSON.stringify(snapshot, null, pretty ? 2 : undefined);
}
export function importSnapshotFromJson(json) {
    return JSON.parse(json);
}
/**
 * Applies a previously captured snapshot back onto a live controller, using
 * only its public API. Node and edge selection are restored; group
 * selection isn't, since GraphController doesn't expose a group-selection
 * setter today (restore it manually via `controller.getState()` if needed).
 */
export function applySnapshot(controller, snapshot) {
    controller.setModel(modelFromJsonObject(snapshot.model));
    controller.setViewport(snapshot.viewport);
    controller.setTheme(GraphTheme.custom(snapshot.theme));
    controller.clearSelection();
    for (const nodeId of snapshot.selection.nodeIds)
        controller.selectNode(nodeId, { additive: true });
    for (const edgeId of snapshot.selection.edgeIds)
        controller.selectEdge(edgeId, { additive: true });
}
//# sourceMappingURL=snapshot.js.map