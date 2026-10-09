function unionRect(rects) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rects) {
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
    }
    if (!isFinite(minX))
        return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
function rectsIntersect(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
/**
 * A static, bulk-loaded R-tree built via the STR (Sort-Tile-Recursive)
 * algorithm — the standard technique for building a near-optimal R-tree in
 * O(n log n) when you have the full entry set up front (as graph-ui
 * always does: a GraphModel snapshot). Immutable and read-only after
 * `build` — for a changed model, rebuild rather than mutate, same
 * trade-off as Quadtree.
 */
export class RTree {
    root;
    constructor(root) {
        this.root = root;
    }
    static build(entries, leafCapacity = 16) {
        if (entries.length === 0) {
            return new RTree({ bounds: { x: 0, y: 0, width: 0, height: 0 }, entries: [] });
        }
        const leaves = strPack(entries, leafCapacity);
        let level = leaves.map((chunk) => ({ bounds: unionRect(chunk.map((e) => e.rect)), entries: chunk }));
        while (level.length > 1) {
            const groups = groupIntoChunks(level, leafCapacity);
            level = groups.map((group) => ({ bounds: unionRect(group.map((n) => n.bounds)), children: group }));
        }
        return new RTree(level[0]);
    }
    queryRect(queryRect) {
        const results = [];
        const stack = [this.root];
        while (stack.length > 0) {
            const node = stack.pop();
            if (!rectsIntersect(node.bounds, queryRect))
                continue;
            if (node.entries) {
                for (const entry of node.entries)
                    if (rectsIntersect(entry.rect, queryRect))
                        results.push(entry.id);
            }
            if (node.children)
                stack.push(...node.children);
        }
        return results;
    }
    nearest(point) {
        let best;
        const minDistToRect = (rect) => {
            const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
            const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
            return Math.hypot(dx, dy);
        };
        // Branch-and-bound: visit nodes in order of their bounding rect's
        // minimum possible distance to `point`, pruning any branch whose bound
        // already exceeds the current best — keeps this well under O(n) on a
        // balanced tree instead of scanning every leaf.
        const stack = [this.root];
        while (stack.length > 0) {
            stack.sort((a, b) => minDistToRect(b.bounds) - minDistToRect(a.bounds)); // pop closest last
            const node = stack.pop();
            if (best && minDistToRect(node.bounds) > best.distance)
                continue;
            if (node.entries) {
                for (const entry of node.entries) {
                    const cx = entry.rect.x + entry.rect.width / 2;
                    const cy = entry.rect.y + entry.rect.height / 2;
                    const d = Math.hypot(cx - point.x, cy - point.y);
                    if (!best || d < best.distance)
                        best = { id: entry.id, distance: d };
                }
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
/** Sort-Tile-Recursive bulk-load packing: sort by x into vertical slices sized ~sqrt(n/capacity), then sort each slice by y into leaf-sized chunks. */
function strPack(entries, leafCapacity) {
    const n = entries.length;
    const leafCount = Math.max(1, Math.ceil(n / leafCapacity));
    const sliceCount = Math.max(1, Math.ceil(Math.sqrt(leafCount)));
    const sliceSize = Math.ceil(n / sliceCount);
    const byX = [...entries].sort((a, b) => centerX(a.rect) - centerX(b.rect));
    const chunks = [];
    for (let s = 0; s < byX.length; s += sliceSize) {
        const slice = byX.slice(s, s + sliceSize).sort((a, b) => centerY(a.rect) - centerY(b.rect));
        for (let i = 0; i < slice.length; i += leafCapacity) {
            chunks.push(slice.slice(i, i + leafCapacity));
        }
    }
    return chunks;
}
function groupIntoChunks(items, size) {
    const groups = [];
    for (let i = 0; i < items.length; i += size)
        groups.push(items.slice(i, i + size));
    return groups;
}
function centerX(rect) {
    return rect.x + rect.width / 2;
}
function centerY(rect) {
    return rect.y + rect.height / 2;
}
//# sourceMappingURL=RTree.js.map