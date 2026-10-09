function metadataMatches(metadata, query) {
    if (!metadata)
        return undefined;
    for (const [key, value] of Object.entries(metadata)) {
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        if (str.toLowerCase().includes(query))
            return `${key}=${str}`;
    }
    return undefined;
}
/**
 * Search over the current model by label, id, or metadata. Immutable —
 * `run` returns a fresh GraphSearch positioned at the first match.
 */
export class GraphSearch {
    result;
    constructor(result = { query: '', matches: [], activeIndex: -1 }) {
        this.result = result;
    }
    static run(query, model) {
        const q = query.trim().toLowerCase();
        if (!q)
            return new GraphSearch();
        const matches = [];
        for (const node of model.nodes) {
            if (node.label.toLowerCase().includes(q)) {
                matches.push({ kind: 'node', id: node.id, field: 'label', matchedValue: node.label });
                continue;
            }
            if (node.id.toLowerCase().includes(q)) {
                matches.push({ kind: 'node', id: node.id, field: 'id', matchedValue: node.id });
                continue;
            }
            const metaHit = metadataMatches(node.metadata, q);
            if (metaHit)
                matches.push({ kind: 'node', id: node.id, field: 'metadata', matchedValue: metaHit });
        }
        for (const edge of model.edges) {
            if (edge.label?.toLowerCase().includes(q)) {
                matches.push({ kind: 'edge', id: edge.id, field: 'label', matchedValue: edge.label });
                continue;
            }
            if (edge.id.toLowerCase().includes(q)) {
                matches.push({ kind: 'edge', id: edge.id, field: 'id', matchedValue: edge.id });
                continue;
            }
            const metaHit = metadataMatches(edge.metadata, q);
            if (metaHit)
                matches.push({ kind: 'edge', id: edge.id, field: 'metadata', matchedValue: metaHit });
        }
        return new GraphSearch({ query, matches, activeIndex: matches.length > 0 ? 0 : -1 });
    }
    get activeMatch() {
        return this.result.activeIndex >= 0 ? this.result.matches[this.result.activeIndex] : undefined;
    }
    next() {
        if (this.result.matches.length === 0)
            return this;
        const activeIndex = (this.result.activeIndex + 1) % this.result.matches.length;
        return new GraphSearch({ ...this.result, activeIndex });
    }
    previous() {
        if (this.result.matches.length === 0)
            return this;
        const activeIndex = (this.result.activeIndex - 1 + this.result.matches.length) % this.result.matches.length;
        return new GraphSearch({ ...this.result, activeIndex });
    }
    clear() {
        return new GraphSearch();
    }
}
//# sourceMappingURL=GraphSearch.js.map