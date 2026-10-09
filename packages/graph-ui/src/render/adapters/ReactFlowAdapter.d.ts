import type { GraphRenderAdapter } from './GraphRenderAdapter.js';
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
    readonly position: {
        x: number;
        y: number;
    };
    readonly data: {
        label: string;
    };
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
/**
 * Creates a GraphRenderAdapter that drives an externally-owned React Flow
 * instance via dependency-injected setter functions. graph-ui itself never
 * imports React or React Flow — the host application wires its own
 * `useNodesState`/`useEdgesState` setters in and hands them here. This is
 * how graph-ui stays framework-agnostic while still supporting React Flow
 * as one interchangeable rendering backend among several.
 */
export declare function createReactFlowAdapter(bindings: ReactFlowBindings): GraphRenderAdapter;
//# sourceMappingURL=ReactFlowAdapter.d.ts.map