import type { GraphController, GraphControllerState } from '../controller/GraphController.js';
import { type GraphSnapshot } from './types.js';
/** Captures a full, JSON-serializable snapshot of a controller's current state. */
export declare function captureSnapshot(state: GraphControllerState, nowMs: number): GraphSnapshot;
export declare function exportSnapshotToJson(snapshot: GraphSnapshot, pretty?: boolean): string;
export declare function importSnapshotFromJson(json: string): GraphSnapshot;
/**
 * Applies a previously captured snapshot back onto a live controller, using
 * only its public API. Node and edge selection are restored; group
 * selection isn't, since GraphController doesn't expose a group-selection
 * setter today (restore it manually via `controller.getState()` if needed).
 */
export declare function applySnapshot(controller: GraphController, snapshot: GraphSnapshot): void;
//# sourceMappingURL=snapshot.d.ts.map