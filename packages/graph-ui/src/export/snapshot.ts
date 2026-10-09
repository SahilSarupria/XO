import type { GraphController, GraphControllerState } from '../controller/GraphController.js';
import { GraphTheme } from '../theme/GraphTheme.js';
import { modelFromJsonObject, modelToJsonObject } from './toJson.js';
import { selectionStateToSnapshot, type GraphSnapshot } from './types.js';

/** Captures a full, JSON-serializable snapshot of a controller's current state. */
export function captureSnapshot(state: GraphControllerState, nowMs: number): GraphSnapshot {
  return {
    version: 1,
    capturedAtMs: nowMs,
    model: modelToJsonObject(state.model),
    viewport: state.viewport.state,
    selection: selectionStateToSnapshot(state.selection.state),
    theme: state.theme.definition,
  };
}

export function exportSnapshotToJson(snapshot: GraphSnapshot, pretty = false): string {
  return JSON.stringify(snapshot, null, pretty ? 2 : undefined);
}

export function importSnapshotFromJson(json: string): GraphSnapshot {
  return JSON.parse(json) as GraphSnapshot;
}

/**
 * Applies a previously captured snapshot back onto a live controller, using
 * only its public API. Node and edge selection are restored; group
 * selection isn't, since GraphController doesn't expose a group-selection
 * setter today (restore it manually via `controller.getState()` if needed).
 */
export function applySnapshot(controller: GraphController, snapshot: GraphSnapshot): void {
  controller.setModel(modelFromJsonObject(snapshot.model));
  controller.setViewport(snapshot.viewport);
  controller.setTheme(GraphTheme.custom(snapshot.theme));
  controller.clearSelection();
  for (const nodeId of snapshot.selection.nodeIds) controller.selectNode(nodeId, { additive: true });
  for (const edgeId of snapshot.selection.edgeIds) controller.selectEdge(edgeId, { additive: true });
}
