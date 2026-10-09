import type { GraphSelectionState, GraphThemeDefinition, GraphViewportState } from '../model/types.js';
import type { GraphModelJson } from './toJson.js';
export interface ClipboardPayload {
    readonly mimeType: 'application/json' | 'image/svg+xml';
    readonly data: string;
}
export type ExportFormat = 'svg' | 'png' | 'json' | 'clipboard' | 'snapshot' | 'print-svg';
/** A fully self-contained, JSON-serializable capture of a controller's
 * state, suitable for saving to disk/localStorage and restoring later. */
export interface GraphSnapshot {
    readonly version: 1;
    readonly capturedAtMs: number;
    readonly model: GraphModelJson;
    readonly viewport: GraphViewportState;
    readonly selection: {
        readonly nodeIds: readonly string[];
        readonly edgeIds: readonly string[];
        readonly groupIds: readonly string[];
    };
    readonly theme: GraphThemeDefinition;
}
export declare function selectionStateToSnapshot(selection: GraphSelectionState): GraphSnapshot['selection'];
//# sourceMappingURL=types.d.ts.map