export function filterNodes(graph, filter = {}) {
    return graph.allNodes().filter((node) => {
        if (filter.kind !== undefined && node.kind !== filter.kind)
            return false;
        if (filter.tag !== undefined && !node.metadata.tags.includes(filter.tag))
            return false;
        if (filter.minConfidence !== undefined && node.metadata.confidence < filter.minConfidence)
            return false;
        if (filter.predicate && !filter.predicate(node))
            return false;
        return true;
    });
}
export function filterEdges(graph, filter = {}) {
    return graph.allEdges().filter((edge) => {
        if (filter.kind !== undefined && edge.kind !== filter.kind)
            return false;
        if (filter.tag !== undefined && !edge.metadata.tags.includes(filter.tag))
            return false;
        if (filter.predicate && !filter.predicate(edge))
            return false;
        return true;
    });
}
/** Convenience wrapper over {@link filterNodes} for the module spec's named lookups ("Capability lookup", "Knowledge lookup", "Reasoning lookup"). */
export function nodesOfKind(graph, kind) {
    return filterNodes(graph, { kind });
}
export function byTag(graph, tag) {
    return filterNodes(graph, { tag });
}
export function relationshipsOfKind(graph, kind) {
    return filterEdges(graph, { kind });
}
/** Breadth-first shortest-path search (by hop count) from `fromId` to `toId`, optionally restricted to one edge kind. Returns `[]` if there is no path within `maxDepth`. */
export function findPath(graph, fromId, toId, options = {}) {
    const maxDepth = options.maxDepth ?? Infinity;
    if (fromId === toId)
        return [fromId];
    const visited = new Set([fromId]);
    const queue = [{ id: fromId, path: [fromId] }];
    while (queue.length > 0) {
        const { id, path } = queue.shift();
        if (path.length - 1 >= maxDepth)
            continue;
        const neighborOpts = options.edgeKind !== undefined ? { edgeKind: options.edgeKind, direction: 'outgoing' } : { direction: 'outgoing' };
        for (const neighbor of graph.neighbors(id, neighborOpts)) {
            if (visited.has(neighbor.id))
                continue;
            const nextPath = [...path, neighbor.id];
            if (neighbor.id === toId)
                return nextPath;
            visited.add(neighbor.id);
            queue.push({ id: neighbor.id, path: nextPath });
        }
    }
    return [];
}
//# sourceMappingURL=query.js.map