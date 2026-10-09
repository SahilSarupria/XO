function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isKnowledgeGraphDocument(value) {
    return isRecord(value) && Array.isArray(value.nodes) && Array.isArray(value.edges);
}
/** Parses a `knowledge_graph` slice's content; returns `undefined` for any other component kind or unparseable/malformed content, never throws. */
export function parseKnowledgeGraphSlice(slice) {
    if (slice.componentKind !== 'knowledge_graph')
        return undefined;
    try {
        const parsed = JSON.parse(slice.content);
        return isKnowledgeGraphDocument(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Merges every `knowledge_graph` slice present in `slices` (across
 * however many mounted packages they came from) into one document —
 * "merging multiple knowledge graphs" from the Stage 2 brief. Nodes are
 * deduplicated by id (first occurrence wins; a later source declaring
 * the same id with different content is recorded in `conflicts`, not
 * silently dropped or overwritten); edges are deduplicated by deep
 * equality. Iterates `slices` in the order given, so the result is fully
 * deterministic for a given input order (callers wanting a canonical
 * order should sort `slices` themselves before calling this).
 */
export function mergeKnowledgeGraphs(slices) {
    const nodesById = new Map();
    const conflicts = [];
    const edgesSeen = new Set();
    const edges = [];
    let sourceCount = 0;
    for (const slice of slices) {
        const doc = parseKnowledgeGraphSlice(slice);
        if (!doc)
            continue;
        sourceCount += 1;
        const sourceLabel = `${slice.packageName}@${slice.packageVersion}`;
        for (const node of doc.nodes) {
            const id = typeof node.id === 'string' ? node.id : undefined;
            if (id === undefined)
                continue; // a node without an id can't be deduplicated or referenced; skip rather than guess one
            const existing = nodesById.get(id);
            if (!existing) {
                nodesById.set(id, { node, sources: [sourceLabel] });
                continue;
            }
            existing.sources.push(sourceLabel);
            if (JSON.stringify(existing.node) !== JSON.stringify(node)) {
                conflicts.push({ nodeId: id, sources: [...existing.sources] });
            }
        }
        for (const edge of doc.edges) {
            const key = JSON.stringify(edge);
            if (!edgesSeen.has(key)) {
                edgesSeen.add(key);
                edges.push(edge);
            }
        }
    }
    return Object.freeze({
        nodes: [...nodesById.values()].map((entry) => entry.node),
        edges,
        sourceCount,
        conflicts,
    });
}
//# sourceMappingURL=knowledge-graph-merge.js.map