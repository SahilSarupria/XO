import type { GraphModel } from '../model/GraphModel.js';
import type { GraphCamera } from '../camera/GraphCamera.js';
import type { GraphSelection } from '../selection/GraphSelection.js';
import type { GraphAnimationEngine } from '../animation/GraphAnimationEngine.js';
import type { HistoryStack } from '../history/HistoryStack.js';
import type { DragState } from '../interaction/DragStateMachine.js';
import type { ResizeState } from '../interaction/ResizeStateMachine.js';
import type { HoverState } from '../interaction/HoverManager.js';
import type { FocusState } from '../interaction/FocusManager.js';
import { type MemoryEstimate, type RenderCostEstimate } from '../diagnostics/GraphDiagnostics.js';
import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';
import type { GraphLayoutOptions, LayoutKind, NodeId } from '../model/types.js';
/**
 * Developer-tool "inspector" data models: each function is a pure snapshot
 * builder that reads already-public state from the corresponding engine
 * and returns a plain, JSON-serializable object. None of these render
 * anything — a host devtools panel (in Studio or elsewhere) is
 * responsible for actually displaying them.
 */
export interface GraphInspectorSnapshot {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly groupCount: number;
    readonly nodeTypeCounts: Readonly<Record<string, number>>;
    readonly edgeTypeCounts: Readonly<Record<string, number>>;
}
export declare function inspectGraph(model: GraphModel): GraphInspectorSnapshot;
export interface InteractionInspectorSnapshot {
    readonly drag: DragState;
    readonly resize: ResizeState;
    readonly hover: HoverState;
    readonly focus: FocusState;
}
export declare function inspectInteraction(drag: DragState, resize: ResizeState, hover: HoverState, focus: FocusState): InteractionInspectorSnapshot;
export interface SelectionInspectorSnapshot {
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly groupCount: number;
    readonly sampleNodeIds: readonly NodeId[];
}
export declare function inspectSelection(selection: GraphSelection, sampleSize?: number): SelectionInspectorSnapshot;
export interface LayoutInspectorSnapshot {
    readonly availableKinds: readonly string[];
    readonly lastComputed?: {
        readonly kind: LayoutKind | string;
        readonly options?: GraphLayoutOptions;
        readonly ms: number;
    };
}
export declare function inspectLayout(availableKinds: readonly string[], lastComputed?: LayoutInspectorSnapshot['lastComputed']): LayoutInspectorSnapshot;
export interface CameraInspectorSnapshot {
    readonly viewport: {
        readonly x: number;
        readonly y: number;
        readonly zoom: number;
    };
    readonly bookmarkNames: readonly string[];
    readonly canUndo: boolean;
    readonly canRedo: boolean;
}
export declare function inspectCamera(camera: GraphCamera): CameraInspectorSnapshot;
export interface PerformanceInspectorSnapshot {
    readonly renderCost: RenderCostEstimate;
    readonly memory: MemoryEstimate;
    readonly recommendations: readonly string[];
}
export declare function inspectPerformance(model: GraphModel, frame: Pick<RenderFrame, 'nodes' | 'edges'>, activeLayoutKind?: string): PerformanceInspectorSnapshot;
export interface AnimationInspectorSnapshot {
    readonly activeIds: readonly string[];
    readonly count: number;
}
export declare function inspectAnimation(engine: GraphAnimationEngine): AnimationInspectorSnapshot;
export interface HistoryInspectorSnapshot {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    readonly pastLength: number;
    readonly futureLength: number;
}
export declare function inspectHistory<T>(history: HistoryStack<T>): HistoryInspectorSnapshot;
//# sourceMappingURL=inspectors.d.ts.map