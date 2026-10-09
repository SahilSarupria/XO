import type { GraphModel } from '../model/GraphModel.js';
import type { GraphViewportState, NodeId, Point, Rect, Size } from '../model/types.js';

export interface ViewportTransition {
  readonly from: GraphViewportState;
  readonly to: GraphViewportState;
  /** Duration in ms; consumers (adapters) animate between from/to over this window. */
  readonly durationMs: number;
}

const DEFAULT_TRANSITION_MS = 240;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function nodeRect(id: NodeId, model: GraphModel): Rect | undefined {
  const node = model.getNode(id);
  if (!node) return undefined;
  const size = node.size ?? { width: 120, height: 40 };
  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
}

function boundsOf(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Immutable viewport state + pure transform helpers. GraphViewport never
 * touches the DOM; adapters are responsible for actually animating between
 * states produced here.
 */
export class GraphViewport {
  readonly state: GraphViewportState;

  constructor(state: GraphViewportState = { x: 0, y: 0, zoom: 1 }) {
    this.state = { ...state, zoom: clampZoom(state.zoom) };
  }

  pan(dx: number, dy: number): GraphViewport {
    return new GraphViewport({ x: this.state.x + dx, y: this.state.y + dy, zoom: this.state.zoom });
  }

  panTo(x: number, y: number): GraphViewport {
    return new GraphViewport({ x, y, zoom: this.state.zoom });
  }

  zoomTo(zoom: number, anchor?: Point): GraphViewport {
    const nextZoom = clampZoom(zoom);
    if (!anchor) return new GraphViewport({ ...this.state, zoom: nextZoom });
    // Keep the world point under `anchor` stationary on screen while zooming.
    const worldX = (anchor.x - this.state.x) / this.state.zoom;
    const worldY = (anchor.y - this.state.y) / this.state.zoom;
    const x = anchor.x - worldX * nextZoom;
    const y = anchor.y - worldY * nextZoom;
    return new GraphViewport({ x, y, zoom: nextZoom });
  }

  zoomBy(factor: number, anchor?: Point): GraphViewport {
    return this.zoomTo(this.state.zoom * factor, anchor);
  }

  /** Fit the given world-space rect into a viewport of `viewportSize`, with padding. */
  private fitRect(rect: Rect, viewportSize: Size, padding = 48): GraphViewport {
    const availW = Math.max(1, viewportSize.width - padding * 2);
    const availH = Math.max(1, viewportSize.height - padding * 2);
    const zoom = clampZoom(Math.min(availW / Math.max(1, rect.width), availH / Math.max(1, rect.height)));
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    const x = viewportSize.width / 2 - centerX * zoom;
    const y = viewportSize.height / 2 - centerY * zoom;
    return new GraphViewport({ x, y, zoom });
  }

  fitToScreen(model: GraphModel, viewportSize: Size, padding?: number): GraphViewport {
    const rects = model.nodes.map((n) => nodeRect(n.id, model)).filter((r): r is Rect => !!r);
    const bounds = boundsOf(rects) ?? { x: 0, y: 0, width: viewportSize.width, height: viewportSize.height };
    return this.fitRect(bounds, viewportSize, padding);
  }

  fitSelection(nodeIds: readonly NodeId[], model: GraphModel, viewportSize: Size, padding?: number): GraphViewport {
    const rects = nodeIds.map((id) => nodeRect(id, model)).filter((r): r is Rect => !!r);
    const bounds = boundsOf(rects);
    if (!bounds) return this;
    return this.fitRect(bounds, viewportSize, padding);
  }

  centerNode(nodeId: NodeId, model: GraphModel, viewportSize: Size): GraphViewport {
    const rect = nodeRect(nodeId, model);
    if (!rect) return this;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    return new GraphViewport({
      x: viewportSize.width / 2 - cx * this.state.zoom,
      y: viewportSize.height / 2 - cy * this.state.zoom,
      zoom: this.state.zoom,
    });
  }

  centerSelection(nodeIds: readonly NodeId[], model: GraphModel, viewportSize: Size): GraphViewport {
    const rects = nodeIds.map((id) => nodeRect(id, model)).filter((r): r is Rect => !!r);
    const bounds = boundsOf(rects);
    if (!bounds) return this;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    return new GraphViewport({
      x: viewportSize.width / 2 - cx * this.state.zoom,
      y: viewportSize.height / 2 - cy * this.state.zoom,
      zoom: this.state.zoom,
    });
  }

  zoomToNode(nodeId: NodeId, model: GraphModel, viewportSize: Size, zoom = 1.5): GraphViewport {
    return this.zoomTo(zoom).centerNode(nodeId, model, viewportSize);
  }

  zoomToSelection(nodeIds: readonly NodeId[], model: GraphModel, viewportSize: Size, padding?: number): GraphViewport {
    return this.fitSelection(nodeIds, model, viewportSize, padding);
  }

  /** World-space rect currently visible on screen — used for culling and the minimap. */
  visibleWorldRect(viewportSize: Size): Rect {
    return {
      x: -this.state.x / this.state.zoom,
      y: -this.state.y / this.state.zoom,
      width: viewportSize.width / this.state.zoom,
      height: viewportSize.height / this.state.zoom,
    };
  }

  worldToScreen(point: Point): Point {
    return { x: point.x * this.state.zoom + this.state.x, y: point.y * this.state.zoom + this.state.y };
  }

  screenToWorld(point: Point): Point {
    return { x: (point.x - this.state.x) / this.state.zoom, y: (point.y - this.state.y) / this.state.zoom };
  }

  transitionTo(target: GraphViewport, durationMs: number = DEFAULT_TRANSITION_MS): ViewportTransition {
    return { from: this.state, to: target.state, durationMs };
  }
}

export function isRectVisible(rect: Rect, viewportWorldRect: Rect): boolean {
  return (
    rect.x + rect.width >= viewportWorldRect.x &&
    rect.x <= viewportWorldRect.x + viewportWorldRect.width &&
    rect.y + rect.height >= viewportWorldRect.y &&
    rect.y <= viewportWorldRect.y + viewportWorldRect.height
  );
}
