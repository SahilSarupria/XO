import type { GraphModel } from '../model/GraphModel.js';
import { GraphViewport } from '../viewport/GraphViewport.js';
import type { Point, Rect, Size } from '../model/types.js';
export interface MinimapGeometry {
    /** World-space bounds of the full graph. */
    readonly worldBounds: Rect;
    /** The current viewport's visible rect, in world space (the "camera box"). */
    readonly viewportRect: Rect;
    /** worldBounds mapped into minimap-local pixel space (0,0 top-left of the minimap). */
    readonly minimapWorldRect: Rect;
    /** viewportRect mapped into minimap-local pixel space — what you draw as the rectangle. */
    readonly minimapViewportRect: Rect;
    readonly scale: number;
}
/**
 * Computes minimap geometry: the small-scale mapping of world bounds and
 * the current viewport rectangle into minimap pixel space, plus the inverse
 * mapping for click-to-navigate. Zoom-aware: the viewport rect shrinks as
 * the main viewport zooms in.
 */
export declare class GraphMinimap {
    static geometry(model: GraphModel, viewport: GraphViewport, viewportSize: Size, minimapSize: Size, padding?: number): MinimapGeometry;
    /** Convert a click on the minimap (minimap-local px) into a new viewport centered there. */
    static navigateFromClick(clickPoint: Point, model: GraphModel, viewport: GraphViewport, viewportSize: Size, minimapSize: Size, padding?: number): GraphViewport;
}
//# sourceMappingURL=GraphMinimap.d.ts.map