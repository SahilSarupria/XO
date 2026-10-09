import type { GraphModel } from '../model/GraphModel.js';
import { GraphLayouts } from '../layout/GraphLayouts.js';
import { GraphSearch } from '../search/GraphSearch.js';
import type { GraphLayoutOptions, LayoutKind } from '../model/types.js';
import type { RenderFrame } from '../render/adapters/GraphRenderAdapter.js';

export interface TimingSample<T> {
  readonly result: T;
  readonly ms: number;
}

export interface RenderCostEstimate {
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** A rough, deterministic estimate of render cost in milliseconds — a heuristic (not measured), intended for budget/recommendation purposes. */
  readonly estimatedMs: number;
}

export interface MemoryEstimate {
  /** Rough estimated bytes, derived from field counts rather than an actual heap snapshot (graph-ui has no access to one, and shouldn't assume a JS engine that exposes it). */
  readonly estimatedBytes: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
}

export interface Hotspot {
  readonly name: string;
  readonly ms: number;
}

/**
 * Deterministic profiling utilities. `measure`/the `time*` helpers use
 * `Date.now()` (standard ECMAScript, available in Node and every browser —
 * not a browser-specific API) purely to time a synchronous call; nothing
 * here samples memory or CPU from the runtime, since graph-ui has no
 * business assuming any particular host environment exposes that.
 */
export class GraphDiagnostics {
  static measure<T>(fn: () => T): TimingSample<T> {
    const start = Date.now();
    const result = fn();
    return { result, ms: Date.now() - start };
  }

  static timeLayout(layouts: GraphLayouts, kind: LayoutKind | string, model: GraphModel, options?: GraphLayoutOptions) {
    return GraphDiagnostics.measure(() => layouts.compute(kind, model, options));
  }

  static timeSearch(model: GraphModel, query: string) {
    return GraphDiagnostics.measure(() => GraphSearch.run(query, model));
  }

  static timeSelection<T>(fn: () => T): TimingSample<T> {
    return GraphDiagnostics.measure(fn);
  }

  /** A rough, heuristic render-cost estimate — linear in node+edge count with a small per-item constant, meant for budget checks and recommendations, not a measured benchmark. */
  static estimateRenderCost(frame: Pick<RenderFrame, 'nodes' | 'edges'>): RenderCostEstimate {
    const nodeCount = frame.nodes.length;
    const edgeCount = frame.edges.length;
    const estimatedMs = nodeCount * 0.01 + edgeCount * 0.005;
    return { nodeCount, edgeCount, estimatedMs };
  }

  /** A rough per-item byte estimate — deliberately simple and deterministic rather than trying to introspect actual memory layout. */
  static estimateMemory(model: GraphModel): MemoryEstimate {
    const BYTES_PER_NODE = 250;
    const BYTES_PER_EDGE = 150;
    return {
      estimatedBytes: model.nodeCount * BYTES_PER_NODE + model.edgeCount * BYTES_PER_EDGE,
      nodeCount: model.nodeCount,
      edgeCount: model.edgeCount,
    };
  }

  /** Given a set of named timing samples, returns the ones exceeding `thresholdMs`, slowest first. */
  static hotspots(samples: Readonly<Record<string, number>>, thresholdMs: number): readonly Hotspot[] {
    return Object.entries(samples)
      .filter(([, ms]) => ms > thresholdMs)
      .map(([name, ms]) => ({ name, ms }))
      .sort((a, b) => b.ms - a.ms);
  }

  /** Rule-based performance recommendations given basic graph/layout stats — pure and deterministic, no measurement involved. */
  static recommendations(stats: { nodeCount: number; edgeCount: number; activeLayoutKind?: string; virtualizationEnabled?: boolean }): readonly string[] {
    const recs: string[] = [];
    if (stats.activeLayoutKind === 'force-directed' && stats.nodeCount > 2000) {
      recs.push('force-directed layout is O(n^2) per iteration — switch to hierarchical/grid above a few thousand nodes.');
    }
    if (stats.nodeCount > 500 && stats.virtualizationEnabled === false) {
      recs.push('Enable viewport culling/virtualization above ~500 nodes to keep the render frame small.');
    }
    if (stats.edgeCount > stats.nodeCount * 10) {
      recs.push('Edge count is far higher than node count — consider edge bundling or filtering by type before rendering.');
    }
    if (stats.nodeCount > 100_000) {
      recs.push('At 100k+ nodes, build a SpatialIndex once per model snapshot and query it rather than scanning the full node list per interaction.');
    }
    return recs;
  }
}
