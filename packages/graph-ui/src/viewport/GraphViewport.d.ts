import type { GraphModel } from '../model/GraphModel.js';
import type { GraphViewportState, NodeId, Point, Rect, Size } from '../model/types.js';
export interface ViewportTransition {
    readonly from: GraphViewportState;
    readonly to: GraphViewportState;
    /** Duration in ms; consumers (adapters) animate between from/to over this window. */
    readonly durationMs: number;
}
/**
 * Immutable viewport state + pure transform helpers. GraphViewport never
 * touches the DOM; adapters are responsible for actually animating between
 * states produced here.
 */
export declare class GraphViewport {
    readonly state: GraphViewportState;
    constructor(state?: GraphViewportState);
    pan(dx: number, dy: number): GraphViewport;
    panTo(x: number, y: number): GraphViewport;
    zoomTo(zoom: number, anchor?: Point): GraphViewport;
    zoomBy(factor: number, anchor?: Point): GraphViewport;
    /** Fit the given world-space rect into a viewport of `viewportSize`, with padding. */
    private fitRect;
    fitToScreen(model: GraphModel, viewportSize: Size, padding?: number): GraphViewport;
    fitSelection(nodeIds: readonly NodeId[], model: GraphModel, viewportSize: Size, padding?: number): GraphViewport;
    centerNode(nodeId: NodeId, model: GraphModel, viewportSize: Size): GraphViewport;
    centerSelection(nodeIds: readonly NodeId[], model: GraphModel, viewportSize: Size): GraphViewport;
    zoomToNode(nodeId: NodeId, model: GraphModel, viewportSize: Size, zoom?: number): GraphViewport;
    zoomToSelection(nodeIds: readonly NodeId[], model: GraphModel, viewportSize: Size, padding?: number): GraphViewport;
    /** World-space rect currently visible on screen — used for culling and the minimap. */
    visibleWorldRect(viewportSize: Size): Rect;
    worldToScreen(point: Point): Point;
    screenToWorld(point: Point): Point;
    transitionTo(target: GraphViewport, durationMs?: number): ViewportTransition;
}
export declare function isRectVisible(rect: Rect, viewportWorldRect: Rect): boolean;
//# sourceMappingURL=GraphViewport.d.ts.map