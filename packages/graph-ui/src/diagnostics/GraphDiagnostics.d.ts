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
export declare class GraphDiagnostics {
    static measure<T>(fn: () => T): TimingSample<T>;
    static timeLayout(layouts: GraphLayouts, kind: LayoutKind | string, model: GraphModel, options?: GraphLayoutOptions): TimingSample<import("../model/types.js").GraphLayoutResult>;
    static timeSearch(model: GraphModel, query: string): TimingSample<GraphSearch>;
    static timeSelection<T>(fn: () => T): TimingSample<T>;
    /** A rough, heuristic render-cost estimate — linear in node+edge count with a small per-item constant, meant for budget checks and recommendations, not a measured benchmark. */
    static estimateRenderCost(frame: Pick<RenderFrame, 'nodes' | 'edges'>): RenderCostEstimate;
    /** A rough per-item byte estimate — deliberately simple and deterministic rather than trying to introspect actual memory layout. */
    static estimateMemory(model: GraphModel): MemoryEstimate;
    /** Given a set of named timing samples, returns the ones exceeding `thresholdMs`, slowest first. */
    static hotspots(samples: Readonly<Record<string, number>>, thresholdMs: number): readonly Hotspot[];
    /** Rule-based performance recommendations given basic graph/layout stats — pure and deterministic, no measurement involved. */
    static recommendations(stats: {
        nodeCount: number;
        edgeCount: number;
        activeLayoutKind?: string;
        virtualizationEnabled?: boolean;
    }): readonly string[];
}
//# sourceMappingURL=GraphDiagnostics.d.ts.map