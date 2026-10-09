function rectsIntersect(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function rectContains(outer, inner) {
    return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}
function quadrantsOf(bounds) {
    const hw = bounds.width / 2;
    const hh = bounds.height / 2;
    return [
        { x: bounds.x, y: bounds.y, width: hw, height: hh }, // NW
        { x: bounds.x + hw, y: bounds.y, width: hw, height: hh }, // NE
        { x: bounds.x, y: bounds.y + hh, width: hw, height: hh }, // SW
        { x: bounds.x + hw, y: bounds.y + hh, width: hw, height: hh }, // SE
    ];
}
/**
 * A capacity-bounded, depth-bounded region quadtree for 2D rects, keyed by
 * NodeId. Built once via `Quadtree.build(entries)` (bulk, iterative) and
 * queried read-only afterward — rebuilding rather than mutating in place
 * keeps it consistent with the rest of the package's immutable-by-default
 * style, while still being fast enough for 1M+ entries (a full rebuild is
 * O(n log n) and query is O(log n + k)).
 */
export class Quadtree {
    root;
    capacity;
    maxDepth;
    constructor(root, capacity, maxDepth) {
        this.root = root;
        this.capacity = capacity;
        this.maxDepth = maxDepth;
    }
    static build(entries, bounds, capacity = 16, maxDepth = 20) {
        const computedBounds = bounds ?? Quadtree.boundsOf(entries);
        const root = { bounds: computedBounds, entries: [] };
        const tree = new Quadtree(root, capacity, maxDepth);
        for (const entry of entries)
            tree.insertInto(root, entry, 0);
        return tree;
    }
    static boundsOf(entries) {
        if (entries.length === 0)
            return { x: -1, y: -1, width: 2, height: 2 };
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const e of entries) {
            minX = Math.min(minX, e.rect.x);
            minY = Math.min(minY, e.rect.y);
            maxX = Math.max(maxX, e.rect.x + e.rect.width);
            maxY = Math.max(maxY, e.rect.y + e.rect.height);
        }
        const pad = Math.max(1, (maxX - minX + maxY - minY) * 0.01);
        return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
    }
    insertInto(node, entry, depth) {
        if (!node.children) {
            node.entries.push(entry);
            if (node.entries.length > this.capacity && depth < this.maxDepth)
                this.subdivide(node, depth);
            return;
        }
        for (const child of node.children) {
            if (rectContains(child.bounds, entry.rect) || rectsIntersect(child.bounds, entry.rect)) {
                this.insertInto(child, entry, depth + 1);
            }
        }
    }
    subdivide(node, depth) {
        const quads = quadrantsOf(node.bounds);
        // Tentatively bucket existing entries per quadrant first, to check
        // whether subdividing would actually reduce load. When entries are
        // large relative to the region (or many share the same point),
        // subdividing can duplicate every entry into every quadrant without
        // shrinking anything — the classic degenerate quadtree case, which
        // would otherwise recurse until maxDepth while entries roughly
        // quadruple at each level. If it wouldn't help, stay a leaf instead
        // (holding more than `capacity` entries is fine — it just means a
        // linear scan over a few extra entries on query, not runaway growth).
        const buckets = [[], [], [], []];
        for (const entry of node.entries) {
            quads.forEach((q, i) => {
                if (rectContains(q, entry.rect) || rectsIntersect(q, entry.rect))
                    buckets[i].push(entry);
            });
        }
        const maxBucket = Math.max(...buckets.map((b) => b.length));
        if (maxBucket >= node.entries.length)
            return;
        const [nw, ne, sw, se] = quads.map((b) => ({ bounds: b, entries: [] }));
        node.children = [nw, ne, sw, se];
        const existing = node.entries;
        node.entries = [];
        for (const entry of existing) {
            for (const child of node.children) {
                if (rectContains(child.bounds, entry.rect) || rectsIntersect(child.bounds, entry.rect)) {
                    this.insertInto(child, entry, depth + 1);
                }
            }
        }
    }
    /** All entry ids whose rect intersects the query rect. */
    queryRect(queryRect) {
        const results = [];
        const seen = new Set();
        const stack = [this.root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (!rectsIntersect(node.bounds, queryRect))
                continue;
            for (const entry of node.entries) {
                if (seen.has(entry.id))
                    continue;
                if (rectsIntersect(entry.rect, queryRect)) {
                    seen.add(entry.id);
                    results.push(entry.id);
                }
            }
            if (node.children)
                stack.push(...node.children);
        }
        return results;
    }
    /** Nearest entry (by center distance) to `point`, or undefined if the tree is empty. */
    nearest(point) {
        let best;
        const stack = [this.root];
        while (stack.length > 0) {
            const node = stack.pop();
            for (const entry of node.entries) {
                const cx = entry.rect.x + entry.rect.width / 2;
                const cy = entry.rect.y + entry.rect.height / 2;
                const d = Math.hypot(cx - point.x, cy - point.y);
                if (!best || d < best.distance)
                    best = { id: entry.id, distance: d };
            }
            if (node.children)
                stack.push(...node.children);
        }
        return best?.id;
    }
    get bounds() {
        return this.root.bounds;
    }
}
//# sourceMappingURL=Quadtree.js.map