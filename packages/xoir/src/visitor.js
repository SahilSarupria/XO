/**
 * Walks every node then every edge in `graph`, invoking `visitor`'s
 * callbacks, and returns the per-node/per-edge results in visit order.
 * `order: 'topological'` walks nodes in dependency order (via
 * `graph.topologicalOrder()`) — useful for a pass that must see a node's
 * dependencies before the node itself; falls back to throwing the same
 * `XOIR_CYCLE_DETECTED` error `topologicalOrder()` would if the graph
 * isn't a DAG, since there is no well-defined topological walk otherwise.
 */
export function traverseGraph(graph, visitor, options = {}) {
    const order = options.order ?? 'insertion';
    const results = [];
    const nodes = order === 'topological'
        ? (() => {
            const topo = graph.topologicalOrder();
            if (!topo.ok)
                throw topo.error;
            return topo.value.map((id) => {
                const result = graph.getNode(id);
                if (!result.ok)
                    throw result.error;
                return result.value;
            });
        })()
        : graph.allNodes();
    if (visitor.visitNode) {
        for (const node of nodes) {
            results.push(visitor.visitNode(node, graph));
        }
    }
    if (visitor.visitEdge) {
        for (const edge of graph.allEdges()) {
            results.push(visitor.visitEdge(edge, graph));
        }
    }
    visitor.onComplete?.(results);
    return results;
}
//# sourceMappingURL=visitor.js.map