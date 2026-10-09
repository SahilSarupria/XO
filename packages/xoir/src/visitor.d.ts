import type { XoirEdge } from './edge-kinds.js';
import type { XoirGraph } from './graph.js';
import type { XoirNode } from './node-kinds.js';
/**
 * The Visitor framework every future compiler/optimization/analysis pass
 * traverses XOIR through, instead of reaching into `XoirGraph`'s internals.
 * A visitor implements only the callbacks it cares about — visiting only
 * nodes, only edges, or both — and `traverseGraph` handles the actual walk
 * order, so a new visitor never needs to re-derive "how do I walk this
 * graph correctly."
 */
export interface GraphVisitor<R = void> {
    visitNode?(node: XoirNode, graph: XoirGraph): R;
    visitEdge?(edge: XoirEdge, graph: XoirGraph): R;
    /** Called once, after every node/edge visit, with the per-item results in visit order. */
    onComplete?(results: readonly R[]): void;
}
export type TraversalOrder = 'insertion' | 'topological';
export interface TraverseOptions {
    readonly order?: TraversalOrder;
}
/**
 * Walks every node then every edge in `graph`, invoking `visitor`'s
 * callbacks, and returns the per-node/per-edge results in visit order.
 * `order: 'topological'` walks nodes in dependency order (via
 * `graph.topologicalOrder()`) — useful for a pass that must see a node's
 * dependencies before the node itself; falls back to throwing the same
 * `XOIR_CYCLE_DETECTED` error `topologicalOrder()` would if the graph
 * isn't a DAG, since there is no well-defined topological walk otherwise.
 */
export declare function traverseGraph<R = void>(graph: XoirGraph, visitor: GraphVisitor<R>, options?: TraverseOptions): readonly R[];
//# sourceMappingURL=visitor.d.ts.map