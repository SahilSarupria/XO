import type { GraphViewportState, Point } from '../model/types.js';

export function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: lerpNumber(a.x, b.x, t), y: lerpNumber(a.y, b.y, t) };
}

export function lerpViewportState(a: GraphViewportState, b: GraphViewportState, t: number): GraphViewportState {
  return { x: lerpNumber(a.x, b.x, t), y: lerpNumber(a.y, b.y, t), zoom: lerpNumber(a.zoom, b.zoom, t) };
}
