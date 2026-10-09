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

const DEFAULTS: Required<VirtualizationOptions> = {
  fullDetailZoom: 0.6,
  simplifiedZoom: 0.2,
  clusterThreshold: 2000,
  clusterCellSize: 400,
};

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
export class VirtualizationEngine {
  private readonly options: Required<VirtualizationOptions>;

  constructor(options: VirtualizationOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  lodForZoom(zoom: number): LodLevel {
    if (zoom >= this.options.fullDetailZoom) return 'full';
    if (zoom >= this.options.simplifiedZoom) return 'simplified';
    return 'dot';
  }

  /** A single node's importance score — larger subtrees / hub nodes matter more when deciding what survives aggressive culling. Purely a function of degree here; callers may weight it further with domain data. */
  importanceScore(model: GraphModel, nodeId: NodeId): number {
    return model.neighborsOf(nodeId).length;
  }

  /** Deterministic grid-bucket clustering: nodes falling in the same `clusterCellSize` cell become one synthetic cluster, centered on their centroid. */
  cluster(model: GraphModel, nodeIds: readonly NodeId[]): readonly Cluster[] {
    const cellSize = this.options.clusterCellSize;
    const buckets = new Map<string, NodeId[]>();
    for (const id of nodeIds) {
      const node = model.getNode(id);
      if (!node) continue;
      const cellX = Math.floor(node.position.x / cellSize);
      const cellY = Math.floor(node.position.y / cellSize);
      const key = `${cellX}:${cellY}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(id);
    }
    const clusters: Cluster[] = [];
    for (const [key, ids] of buckets) {
      const points = ids.map((id) => model.getNode(id)!.position);
      const center = {
        x: points.reduce((s, p) => s + p.x, 0) / points.length,
        y: points.reduce((s, p) => s + p.y, 0) / points.length,
      };
      clusters.push({ id: `cluster:${key}`, nodeIds: ids, center, count: ids.length });
    }
    return clusters;
  }

  /**
   * The main entry point: cull to `viewportRect` via the spatial index,
   * pick an LOD from `zoom`, and cluster the result if it's both zoomed
   * out (dot LOD) and over `clusterThreshold` visible nodes.
   */
  computeVisible(model: GraphModel, spatialIndex: SpatialIndex, viewportRect: Rect, zoom: number): VirtualizationResult {
    const visibleNodeIds = spatialIndex.queryViewport(viewportRect);
    const lod = this.lodForZoom(zoom);
    if (lod === 'dot' && visibleNodeIds.length > this.options.clusterThreshold) {
      return { visibleNodeIds, lod, clusters: this.cluster(model, visibleNodeIds) };
    }
    return { visibleNodeIds, lod };
  }

  /** Expands a viewport rect in the direction of travel (a velocity vector, world-units/ms) — used to prefetch/predictively load geometry just outside the current view before the camera gets there. */
  predictiveViewport(viewportRect: Rect, velocity: Point, lookaheadMs: number): Rect {
    const dx = velocity.x * lookaheadMs;
    const dy = velocity.y * lookaheadMs;
    return {
      x: viewportRect.x + Math.min(0, dx),
      y: viewportRect.y + Math.min(0, dy),
      width: viewportRect.width + Math.abs(dx),
      height: viewportRect.height + Math.abs(dy),
    };
  }

  /** Diffs two visible-id sets (e.g. this frame vs last frame) into what should be mounted vs unmounted — the basis for incremental renderer updates. */
  static diff(previous: readonly NodeId[], next: readonly NodeId[]): VirtualizationDiff {
    const prevSet = new Set(previous);
    const nextSet = new Set(next);
    return {
      entered: next.filter((id) => !prevSet.has(id)),
      exited: previous.filter((id) => !nextSet.has(id)),
    };
  }
}
