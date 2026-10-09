import type { GraphRenderAdapter, RenderFrame } from './GraphRenderAdapter.js';

/**
 * Structural shape graph-ui hands to a React Flow binding — deliberately
 * NOT imported from the `reactflow` / `@xyflow/react` package, so this
 * package never takes a hard dependency on it (and never leaks its types
 * into the public API). It happens to line up with what those libraries
 * expect a node/edge object to look like, so the binding function below is
 * typically a direct pass-through.
 */
export interface ReactFlowLikeNode {
  readonly id: string;
  readonly position: { x: number; y: number };
  readonly data: { label: string };
  readonly style?: Record<string, unknown>;
  readonly selected?: boolean;
}

export interface ReactFlowLikeEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string;
  readonly animated?: boolean;
  readonly style?: Record<string, unknown>;
  readonly selected?: boolean;
}

export interface ReactFlowBindings {
  /** Typically `setNodes` from React Flow's `useNodesState`. */
  readonly setNodes: (nodes: readonly ReactFlowLikeNode[]) => void;
  /** Typically `setEdges` from React Flow's `useEdgesState`. */
  readonly setEdges: (edges: readonly ReactFlowLikeEdge[]) => void;
}

function toStyle(style: { fill?: string; stroke?: string; strokeWidth?: number; textColor?: string }): Record<string, unknown> {
  return {
    background: style.fill,
    borderColor: style.stroke,
    borderWidth: style.strokeWidth,
    color: style.textColor,
  };
}

/**
 * Creates a GraphRenderAdapter that drives an externally-owned React Flow
 * instance via dependency-injected setter functions. graph-ui itself never
 * imports React or React Flow — the host application wires its own
 * `useNodesState`/`useEdgesState` setters in and hands them here. This is
 * how graph-ui stays framework-agnostic while still supporting React Flow
 * as one interchangeable rendering backend among several.
 */
export function createReactFlowAdapter(bindings: ReactFlowBindings): GraphRenderAdapter {
  return {
    name: 'react-flow',
    render(frame: RenderFrame): void {
      bindings.setNodes(
        frame.nodes.map((n) => ({
          id: n.node.id,
          position: n.node.position,
          data: { label: n.node.label },
          style: toStyle(n.style),
          selected: n.selected,
        })),
      );
      bindings.setEdges(
        frame.edges.map((e) => ({
          id: e.edge.id,
          source: e.edge.source,
          target: e.edge.target,
          ...(e.edge.label !== undefined ? { label: e.edge.label } : {}),
          ...(e.style.animated !== undefined ? { animated: e.style.animated } : {}),
          style: { stroke: e.style.stroke, strokeWidth: e.style.strokeWidth },
          selected: e.selected,
        })),
      );
    },
  };
}
