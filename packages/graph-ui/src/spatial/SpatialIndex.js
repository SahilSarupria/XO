import { Quadtree } from './Quadtree.js';
import { RTree } from './RTree.js';
const DEFAULT_NODE_SIZE = { width: 120, height: 40 };
function nodeRect(model, id) {
    const node = model.getNode(id);
    if (!node)
        return undefined;
    const size = node.size ?? DEFAULT_NODE_SIZE;
    return { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
}
function edgeBoundingRect(model, edgeId) {
    const edge = model.getEdge(edgeId);
    if (!edge)
        return undefined;
    const source = nodeRect(model, edge.source);
    const target = nodeRect(model, edge.target);
    if (!source || !target)
        return undefined;
    const sx = source.x + source.width / 2;
    const sy = source.y + source.height / 2;
    const tx = target.x + target.width / 2;
    const ty = target.y + target.height / 2;
    return { x: Math.min(sx, tx), y: Math.min(sy, ty), width: Math.abs(tx - sx) || 1, height: Math.abs(ty - sy) || 1 };
}
/**
 * Unified spatial-query facade over GraphModel, backed by either a
 * Quadtree or a bulk-loaded RTree (interchangeable — same query surface).
 * Built once per model snapshot via `SpatialIndex.build`, then queried
 * read-only; rebuild when the model changes. This is what backs viewport
 * queries, nearest-node/edge lookups, collision detection, and region
 * lookups at 100k–1M+ node scale (queries are O(log n + k), and both
 * backends build in O(n log n)).
 */
export class SpatialIndex {
    model;
    nodeIndex;
    edgeIndex;
    constructor(model, nodeIndex, edgeIndex) {
        this.model = model;
        this.nodeIndex = nodeIndex;
        this.edgeIndex = edgeIndex;
    }
    static build(model, backend = 'quadtree') {
        const nodeEntries = model.nodes.map((n) => ({ id: n.id, rect: nodeRect(model, n.id) }));
        const edgeEntries = model.edges
            .map((e) => ({ id: e.id, rect: edgeBoundingRect(model, e.id) }))
            .filter((e) => !!e.rect);
        const nodeIndex = backend === 'rtree' ? RTree.build(nodeEntries) : Quadtree.build(nodeEntries);
        const edgeIndex = backend === 'rtree' ? RTree.build(edgeEntries) : Quadtree.build(edgeEntries);
        return new SpatialIndex(model, nodeIndex, edgeIndex);
    }
    /** All node ids whose bounding rect intersects the given viewport/query rect. */
    queryViewport(rect) {
        return this.nodeIndex.queryRect(rect);
    }
    /** Alias of queryViewport, phrased for arbitrary (non-viewport) region lookups. */
    queryRegion(rect) {
        return this.queryViewport(rect);
    }
    /** Node ids whose bounding rect intersects `rect` — collision/overlap detection against an arbitrary shape (e.g. a dragged node's new bounds). */
    collidingNodes(rect, excludeId) {
        return this.nodeIndex.queryRect(rect).filter((id) => id !== excludeId);
    }
    /** Edge ids whose bounding-box intersects the given rect (a cheap broad-phase test — good enough for viewport culling of edges). */
    queryEdgesInRect(rect) {
        return this.edgeIndex.queryRect(rect);
    }
    nearestNode(point) {
        return this.nodeIndex.nearest(point);
    }
    nearestEdge(point) {
        return this.edgeIndex.nearest(point);
    }
    get bounds() {
        return this.nodeIndex.bounds;
    }
}
//# sourceMappingURL=SpatialIndex.js.map