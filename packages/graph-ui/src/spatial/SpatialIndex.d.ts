import type { GraphModel } from '../model/GraphModel.js';
import type { EdgeId, NodeId, Point, Rect } from '../model/types.js';
export type SpatialBackend = 'quadtree' | 'rtree';
/**
 * Unified spatial-query facade over GraphModel, backed by either a
 * Quadtree or a bulk-loaded RTree (interchangeable — same query surface).
 * Built once per model snapshot via `SpatialIndex.build`, then queried
 * read-only; rebuild when the model changes. This is what backs viewport
 * queries, nearest-node/edge lookups, collision detection, and region
 * lookups at 100k–1M+ node scale (queries are O(log n + k), and both
 * backends build in O(n log n)).
 */
export declare class SpatialIndex {
    private readonly model;
    private readonly nodeIndex;
    private readonly edgeIndex;
    private constructor();
    static build(model: GraphModel, backend?: SpatialBackend): SpatialIndex;
    /** All node ids whose bounding rect intersects the given viewport/query rect. */
    queryViewport(rect: Rect): readonly NodeId[];
    /** Alias of queryViewport, phrased for arbitrary (non-viewport) region lookups. */
    queryRegion(rect: Rect): readonly NodeId[];
    /** Node ids whose bounding rect intersects `rect` — collision/overlap detection against an arbitrary shape (e.g. a dragged node's new bounds). */
    collidingNodes(rect: Rect, excludeId?: NodeId): readonly NodeId[];
    /** Edge ids whose bounding-box intersects the given rect (a cheap broad-phase test — good enough for viewport culling of edges). */
    queryEdgesInRect(rect: Rect): readonly EdgeId[];
    nearestNode(point: Point): NodeId | undefined;
    nearestEdge(point: Point): EdgeId | undefined;
    get bounds(): Rect;
}
//# sourceMappingURL=SpatialIndex.d.ts.map