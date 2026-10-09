import { GraphModel } from '../model/GraphModel.js';
import { GraphViewport } from '../viewport/GraphViewport.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import { GraphSearch } from '../search/GraphSearch.js';
import { GraphFilters } from '../filter/GraphFilters.js';
import { GraphLayouts } from '../layout/GraphLayouts.js';
import { GraphTheme } from '../theme/GraphTheme.js';
import { GraphExecutionState } from '../execution/GraphExecutionState.js';
import type { EdgeId, GraphLayoutOptions, GraphViewportState, LayoutKind, NodeId, Rect, Size } from '../model/types.js';
export interface GraphControllerState {
    readonly model: GraphModel;
    readonly viewport: GraphViewport;
    readonly selection: GraphSelection;
    readonly search: GraphSearch;
    readonly filters: GraphFilters;
    readonly theme: GraphTheme;
    readonly execution: GraphExecutionState;
}
type ControllerListener = (state: GraphControllerState) => void;
/**
 * GraphController is the single orchestration point: it owns the current
 * (immutable) model/viewport/selection/search/filters/theme/execution state
 * and exposes one mutable, stateful API over them. GraphCanvas wires a
 * GraphController to a GraphRenderer + a rendering adapter; nothing else in
 * the package needs to know both exist.
 */
export declare class GraphController {
    readonly layouts: GraphLayouts;
    private state;
    private readonly listeners;
    /** Undo/redo history over the model, committed to by setModel/updateModel/applyLayout. */
    private modelHistory;
    constructor(init?: {
        model?: GraphModel;
        theme?: GraphTheme;
        layouts?: GraphLayouts;
    });
    getState(): GraphControllerState;
    /** The model after filters are applied — what should actually be rendered/searched against. */
    get visibleModel(): GraphModel;
    subscribe(listener: ControllerListener): () => void;
    private setState;
    /** Commits a new model as the current present, recording the previous one for undo(). */
    private commitModel;
    setModel(model: GraphModel): void;
    updateModel(updater: (model: GraphModel) => GraphModel): void;
    /** Reverts to the model before the last setModel/updateModel/applyLayout call, if any. */
    undo(): void;
    /** Re-applies a model previously reverted by undo(), if any. */
    redo(): void;
    get canUndo(): boolean;
    get canRedo(): boolean;
    applyLayout(kind: LayoutKind | string, options?: GraphLayoutOptions): void;
    setViewport(state: GraphViewportState): void;
    pan(dx: number, dy: number): void;
    zoomBy(factor: number, anchor?: {
        x: number;
        y: number;
    }): void;
    fitToScreen(viewportSize: Size): void;
    fitSelection(viewportSize: Size): void;
    centerNode(nodeId: NodeId, viewportSize: Size): void;
    zoomToNode(nodeId: NodeId, viewportSize: Size, zoom?: number): void;
    zoomToSelection(viewportSize: Size): void;
    selectNode(id: NodeId, options?: {
        additive?: boolean;
    }): void;
    toggleNodeSelection(id: NodeId): void;
    selectEdge(id: EdgeId, options?: {
        additive?: boolean;
    }): void;
    selectBox(rect: Rect): void;
    clearSelection(): void;
    search(query: string): void;
    nextMatch(): void;
    previousMatch(): void;
    clearSearch(): void;
    setFilters(filters: GraphFilters): void;
    updateFilters(updater: (filters: GraphFilters) => GraphFilters): void;
    setTheme(theme: GraphTheme): void;
    updateExecution(updater: (execution: GraphExecutionState) => GraphExecutionState): void;
    resetExecution(): void;
}
export {};
//# sourceMappingURL=GraphController.d.ts.map