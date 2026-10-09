import type { NodeId, Point, Rect } from '../model/types.js';
interface Entry {
    readonly id: NodeId;
    readonly rect: Rect;
}
/**
 * A static, bulk-loaded R-tree built via the STR (Sort-Tile-Recursive)
 * algorithm — the standard technique for building a near-optimal R-tree in
 * O(n log n) when you have the full entry set up front (as graph-ui
 * always does: a GraphModel snapshot). Immutable and read-only after
 * `build` — for a changed model, rebuild rather than mutate, same
 * trade-off as Quadtree.
 */
export declare class RTree {
    private readonly root;
    private constructor();
    static build(entries: readonly Entry[], leafCapacity?: number): RTree;
    queryRect(queryRect: Rect): NodeId[];
    nearest(point: Point): NodeId | undefined;
    get bounds(): Rect;
}
export type { Entry as RTreeEntry };
//# sourceMappingURL=RTree.d.ts.map