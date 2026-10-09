import type { GraphModel } from '../model/GraphModel.js';
import { SpatialIndex } from '../spatial/SpatialIndex.js';
import type { NodeId, Point, Rect } from '../model/types.js';
export type LodLevel = 'full' | 'simplified' | 'dot';
export interface VirtualizationOptions {
    /** Zoom at/above which nodes render at full detail. */
    readonly fullDetailZoom?: number;
    /** Zoom at/above which nodes render simplified (below this, they're dots). */
    readonly simplifiedZoom?: number;
    /** Node/edge count above which clustering kicks in at low zoom. */
    readonly clusterThreshold?: number;
    /** Grid cell size (world units) used to bucket nodes into clusters. */
    readonly clusterCellSize?: number;
}
export interface Cluster {
    readonly id: string;
    readonly nodeIds: readonly NodeId[];
    readonly center: Point;
    readonly count: number;
}
export interface VirtualizationResult {
    readonly visibleNodeIds: readonly NodeId[];
    readonly lod: LodLevel;
    readonly clusters?: readonly Cluster[];
}
export interface VirtualizationDiff {
    readonly entered: readonly NodeId[];
    readonly exited: readonly NodeId[];
}
/**
 * Renderer-independent virtualization: given a spatial index and the
 * current camera/viewport, decides what should actually be handed to a
 * renderer — culled to the visible rect, downgraded to a coarser level of
 * detail at low zoom, and (above `clusterThreshold`) collapsed into
 * synthetic clusters instead of individual nodes. Every method is a pure
 * function of its inputs; nothing here touches a renderer or the DOM.
 */
export declare class VirtualizationEngine {
    private readonly options;
    constructor(options?: VirtualizationOptions);
    lodForZoom(zoom: number): LodLevel;
    /** A single node's importance score — larger subtrees / hub nodes matter more when deciding what survives aggressive culling. Purely a function of degree here; callers may weight it further with domain data. */
    importanceScore(model: GraphModel, nodeId: NodeId): number;
    /** Deterministic grid-bucket clustering: nodes falling in the same `clusterCellSize` cell become one synthetic cluster, centered on their centroid. */
    cluster(model: GraphModel, nodeIds: readonly NodeId[]): readonly Cluster[];
    /**
     * The main entry point: cull to `viewportRect` via the spatial index,
     * pick an LOD from `zoom`, and cluster the result if it's both zoomed
     * out (dot LOD) and over `clusterThreshold` visible nodes.
     */
    computeVisible(model: GraphModel, spatialIndex: SpatialIndex, viewportRect: Rect, zoom: number): VirtualizationResult;
    /** Expands a viewport rect in the direction of travel (a velocity vector, world-units/ms) — used to prefetch/predictively load geometry just outside the current view before the camera gets there. */
    predictiveViewport(viewportRect: Rect, velocity: Point, lookaheadMs: number): Rect;
    /** Diffs two visible-id sets (e.g. this frame vs last frame) into what should be mounted vs unmounted — the basis for incremental renderer updates. */
    static diff(previous: readonly NodeId[], next: readonly NodeId[]): VirtualizationDiff;
}
//# sourceMappingURL=VirtualizationEngine.d.ts.map