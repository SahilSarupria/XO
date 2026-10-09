import { GraphSearch } from '../search/GraphSearch.js';
/**
 * Deterministic profiling utilities. `measure`/the `time*` helpers use
 * `Date.now()` (standard ECMAScript, available in Node and every browser —
 * not a browser-specific API) purely to time a synchronous call; nothing
 * here samples memory or CPU from the runtime, since graph-ui has no
 * business assuming any particular host environment exposes that.
 */
export class GraphDiagnostics {
    static measure(fn) {
        const start = Date.now();
        const result = fn();
        return { result, ms: Date.now() - start };
    }
    static timeLayout(layouts, kind, model, options) {
        return GraphDiagnostics.measure(() => layouts.compute(kind, model, options));
    }
    static timeSearch(model, query) {
        return GraphDiagnostics.measure(() => GraphSearch.run(query, model));
    }
    static timeSelection(fn) {
        return GraphDiagnostics.measure(fn);
    }
    /** A rough, heuristic render-cost estimate — linear in node+edge count with a small per-item constant, meant for budget checks and recommendations, not a measured benchmark. */
    static estimateRenderCost(frame) {
        const nodeCount = frame.nodes.length;
        const edgeCount = frame.edges.length;
        const estimatedMs = nodeCount * 0.01 + edgeCount * 0.005;
        return { nodeCount, edgeCount, estimatedMs };
    }
    /** A rough per-item byte estimate — deliberately simple and deterministic rather than trying to introspect actual memory layout. */
    static estimateMemory(model) {
        const BYTES_PER_NODE = 250;
        const BYTES_PER_EDGE = 150;
        return {
            estimatedBytes: model.nodeCount * BYTES_PER_NODE + model.edgeCount * BYTES_PER_EDGE,
            nodeCount: model.nodeCount,
            edgeCount: model.edgeCount,
        };
    }
    /** Given a set of named timing samples, returns the ones exceeding `thresholdMs`, slowest first. */
    static hotspots(samples, thresholdMs) {
        return Object.entries(samples)
            .filter(([, ms]) => ms > thresholdMs)
            .map(([name, ms]) => ({ name, ms }))
            .sort((a, b) => b.ms - a.ms);
    }
    /** Rule-based performance recommendations given basic graph/layout stats — pure and deterministic, no measurement involved. */
    static recommendations(stats) {
        const recs = [];
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
//# sourceMappingURL=GraphDiagnostics.js.map