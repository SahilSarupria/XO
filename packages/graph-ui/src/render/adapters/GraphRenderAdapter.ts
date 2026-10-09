import type { EdgeStyle, GraphEdge, GraphNode, NodeStyle, Point } from '../../model/types.js';

/**
 * The contract every rendering backend must satisfy. graph-ui's public API
 * never leaks a specific rendering library's types — callers depend only on
 * this interface, and swap adapters (SVG string, Canvas, WebGL, React Flow,
 * ...) without touching anything upstream.
 */
export interface RenderableNode {
  readonly node: GraphNode;
  readonly style: NodeStyle;
  readonly selected: boolean;
  readonly hovered: boolean;
}

export interface RenderableEdge {
  readonly edge: GraphEdge;
  readonly style: EdgeStyle;
  readonly sourcePoint: Point;
  readonly targetPoint: Point;
  readonly selected: boolean;
  readonly hovered: boolean;
}

export interface RenderFrame {
  readonly background: string;
  readonly nodes: readonly RenderableNode[];
  readonly edges: readonly RenderableEdge[];
}

export interface GraphRenderAdapter {
  readonly name: string;
  /** Render (or diff-update) a frame. Adapters decide how to reconcile
   * against their own previous output — graph-ui only guarantees `frame`
   * is deterministically ordered. */
  render(frame: RenderFrame): void;
  /** Release any resources held by the adapter (DOM nodes, GL contexts, ...). */
  dispose?(): void;
}
