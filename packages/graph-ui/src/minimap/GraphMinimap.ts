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

function boundsOf(model: GraphModel): Rect {
  if (model.nodeCount === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of model.nodes) {
    const size = node.size ?? { width: 120, height: 40 };
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * Computes minimap geometry: the small-scale mapping of world bounds and
 * the current viewport rectangle into minimap pixel space, plus the inverse
 * mapping for click-to-navigate. Zoom-aware: the viewport rect shrinks as
 * the main viewport zooms in.
 */
export class GraphMinimap {
  static geometry(model: GraphModel, viewport: GraphViewport, viewportSize: Size, minimapSize: Size, padding = 8): MinimapGeometry {
    const worldBounds = boundsOf(model);
    const availW = Math.max(1, minimapSize.width - padding * 2);
    const availH = Math.max(1, minimapSize.height - padding * 2);
    const scale = Math.min(availW / worldBounds.width, availH / worldBounds.height);

    const toMinimap = (rect: Rect): Rect => ({
      x: padding + (rect.x - worldBounds.x) * scale,
      y: padding + (rect.y - worldBounds.y) * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    });

    const viewportRect = viewport.visibleWorldRect(viewportSize);

    return {
      worldBounds,
      viewportRect,
      minimapWorldRect: toMinimap(worldBounds),
      minimapViewportRect: toMinimap(viewportRect),
      scale,
    };
  }

  /** Convert a click on the minimap (minimap-local px) into a new viewport centered there. */
  static navigateFromClick(
    clickPoint: Point,
    model: GraphModel,
    viewport: GraphViewport,
    viewportSize: Size,
    minimapSize: Size,
    padding = 8,
  ): GraphViewport {
    const geom = GraphMinimap.geometry(model, viewport, viewportSize, minimapSize, padding);
    const worldX = geom.worldBounds.x + (clickPoint.x - padding) / geom.scale;
    const worldY = geom.worldBounds.y + (clickPoint.y - padding) / geom.scale;
    return new GraphViewport({
      x: viewportSize.width / 2 - worldX * viewport.state.zoom,
      y: viewportSize.height / 2 - worldY * viewport.state.zoom,
      zoom: viewport.state.zoom,
    });
  }
}
