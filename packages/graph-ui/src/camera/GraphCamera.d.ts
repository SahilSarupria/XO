import { GraphViewport } from '../viewport/GraphViewport.js';
import { GraphAnimationEngine } from '../animation/GraphAnimationEngine.js';
import type { GraphModel } from '../model/GraphModel.js';
import type { Easing } from '../animation/easing.js';
import type { GraphViewportState, NodeId, Size } from '../model/types.js';
/**
 * A pure camera model: wraps GraphViewport (reused, not redesigned) with
 * named bookmarks, undo/redo history (built on HistoryStack), and animated
 * travel between states (built on the animation engine's viewport-transition
 * helpers). All the actual pan/zoom/fit math still lives in GraphViewport —
 * GraphCamera only adds the bookkeeping a camera needs on top of it.
 */
export declare class GraphCamera {
    readonly viewport: GraphViewport;
    private readonly bookmarks;
    private readonly history;
    private constructor();
    static create(initial?: GraphViewportState): GraphCamera;
    private withViewport;
    pan(dx: number, dy: number): GraphCamera;
    zoomBy(factor: number, anchor?: {
        x: number;
        y: number;
    }): GraphCamera;
    fitToScreen(model: GraphModel, viewportSize: Size): GraphCamera;
    focus(nodeId: NodeId, model: GraphModel, viewportSize: Size, zoom?: number): GraphCamera;
    bookmark(name: string): GraphCamera;
    removeBookmark(name: string): GraphCamera;
    getBookmark(name: string): GraphViewportState | undefined;
    get bookmarkNames(): readonly string[];
    goToBookmark(name: string): GraphCamera;
    undo(): GraphCamera;
    redo(): GraphCamera;
    get canUndo(): boolean;
    get canRedo(): boolean;
    /** Starts an animated transition to `target`, returning both the updated camera (committed immediately, for history/bookmark purposes) and an animation engine a renderer can sample every frame via `GraphCamera.animatedStateAt`. */
    travelTo(target: GraphViewportState, durationMs: number, nowMs: number, easing?: Easing): {
        camera: GraphCamera;
        engine: GraphAnimationEngine;
    };
    static animatedStateAt(engine: GraphAnimationEngine, nowMs: number, fallback: GraphViewportState): GraphViewportState;
    static isTravelComplete(engine: GraphAnimationEngine, nowMs: number): boolean;
}
//# sourceMappingURL=GraphCamera.d.ts.map