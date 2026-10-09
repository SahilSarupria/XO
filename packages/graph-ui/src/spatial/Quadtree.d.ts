import type { NodeId, Point, Rect } from '../model/types.js';
interface Entry {
    readonly id: NodeId;
    readonly rect: Rect;
}
/**
 * A capacity-bounded, depth-bounded region quadtree for 2D rects, keyed by
 * NodeId. Built once via `Quadtree.build(entries)` (bulk, iterative) and
 * queried read-only afterward — rebuilding rather than mutating in place
 * keeps it consistent with the rest of the package's immutable-by-default
 * style, while still being fast enough for 1M+ entries (a full rebuild is
 * O(n log n) and query is O(log n + k)).
 */
export declare class Quadtree {
    private readonly root;
    private readonly capacity;
    private readonly maxDepth;
    private constructor();
    static build(entries: readonly Entry[], bounds?: Rect, capacity?: number, maxDepth?: number): Quadtree;
    private static boundsOf;
    private insertInto;
    private subdivide;
    /** All entry ids whose rect intersects the query rect. */
    queryRect(queryRect: Rect): NodeId[];
    /** Nearest entry (by center distance) to `point`, or undefined if the tree is empty. */
    nearest(point: Point): NodeId | undefined;
    get bounds(): Rect;
}
export type { Entry as QuadtreeEntry };
//# sourceMappingURL=Quadtree.d.ts.map