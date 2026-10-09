import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphLayouts } from '../src/layout/GraphLayouts.js';
import { GraphFilters } from '../src/filter/GraphFilters.js';
import { GraphRenderer } from '../src/render/GraphRenderer.js';
import { SvgStringAdapter } from '../src/render/adapters/SvgStringAdapter.js';
import { GraphTheme } from '../src/theme/GraphTheme.js';
import { GraphViewport } from '../src/viewport/GraphViewport.js';
import { GraphSearch } from '../src/search/GraphSearch.js';
import { GraphMinimap } from '../src/minimap/GraphMinimap.js';
import { GraphController } from '../src/controller/GraphController.js';
const NODE_COUNT = 100_000;
const EDGE_COUNT = 500_000;
/** A wide multi-root forest (not one long chain) so tree/hierarchical layouts
 * get realistic fan-out, plus extra cross edges layered on to reach 500k. */
function buildStressGraph() {
    const columns = 400;
    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
        id: `n${i}`,
        type: i % 7 === 0 ? 'hub' : 'leaf',
        label: `Node ${i}`,
        // Pre-spread on a grid so viewport-culling and minimap tests have real
        // spatial variance to work with (layout tests below recompute their
        // own positions independently of this).
        position: { x: (i % columns) * 40, y: Math.floor(i / columns) * 40 },
    }));
    const edges = [];
    // Forest: each node (after the first BRANCH roots) attaches to an earlier node, capped branching factor.
    const BRANCH = 4;
    for (let i = 1; i < NODE_COUNT; i++) {
        const parent = Math.floor((i - 1) / BRANCH);
        edges.push({ id: `tree-e${i}`, type: 'tree', source: `n${parent}`, target: `n${i}` });
    }
    // Extra cross edges to reach ~500k total, deterministic (no RNG). Several
    // per source node, each with a different multiplier, so we can hit the
    // target count without looping more than a small constant times NODE_COUNT.
    const targetExtra = EDGE_COUNT - edges.length;
    const multipliers = [2654435761, 40503, 2246822519, 3266489917, 668265263];
    let extra = 0;
    outer: for (const mult of multipliers) {
        for (let i = 0; i < NODE_COUNT; i++) {
            if (extra >= targetExtra)
                break outer;
            const b = (i * mult) % NODE_COUNT;
            if (i === b)
                continue;
            edges.push({ id: `cross-e${extra}`, type: 'cross', source: `n${i}`, target: `n${b}` });
            extra++;
        }
    }
    return GraphModel.empty().upsertNodes(nodes).upsertEdges(edges);
}
// Build once and share across tests in this file — construction itself is part of what we're timing once, then reused.
let graph;
test('builds a 100k-node / 500k-edge graph within a reasonable time budget', () => {
    const start = Date.now();
    graph = buildStressGraph();
    const elapsedMs = Date.now() - start;
    assert.equal(graph.nodeCount, NODE_COUNT);
    assert.ok(graph.edgeCount >= EDGE_COUNT * 0.98 && graph.edgeCount <= EDGE_COUNT, `unexpected edge count: ${graph.edgeCount}`);
    assert.ok(elapsedMs < 15_000, `graph construction took too long: ${elapsedMs}ms`);
});
test('maintains deterministic node/edge ordering at scale', () => {
    assert.equal(graph.nodes[0].id, 'n0');
    assert.equal(graph.nodes[NODE_COUNT - 1].id, `n${NODE_COUNT - 1}`);
});
test('grid layout computes positions for 100k nodes within budget', () => {
    const layouts = new GraphLayouts();
    const start = Date.now();
    const result = layouts.compute('grid', graph, { columns: 400, spacingX: 40, spacingY: 40 });
    const elapsedMs = Date.now() - start;
    assert.equal(result.positions.length, NODE_COUNT);
    assert.ok(elapsedMs < 5_000, `grid layout took too long: ${elapsedMs}ms`);
});
test('hierarchical (BFS-layered) layout handles 100k nodes / 500k edges without exploding', () => {
    const layouts = new GraphLayouts();
    const start = Date.now();
    const result = layouts.compute('hierarchical', graph);
    const elapsedMs = Date.now() - start;
    assert.equal(result.positions.length, NODE_COUNT);
    assert.ok(elapsedMs < 15_000, `hierarchical layout took too long: ${elapsedMs}ms`);
});
test('tree layout is stack-safe and correct at 100k nodes (iterative, not recursive)', () => {
    const layouts = new GraphLayouts();
    const start = Date.now();
    const result = layouts.compute('tree', graph);
    const elapsedMs = Date.now() - start;
    assert.equal(result.positions.length, NODE_COUNT);
    assert.ok(elapsedMs < 15_000, `tree layout took too long: ${elapsedMs}ms`);
});
test('tree layout handles a single 100k-node linear chain without a stack overflow', () => {
    const nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
        id: `c${i}`,
        type: 't',
        label: `${i}`,
        position: { x: 0, y: 0 },
    }));
    const edges = Array.from({ length: NODE_COUNT - 1 }, (_, i) => ({
        id: `ce${i}`,
        type: 'l',
        source: `c${i}`,
        target: `c${i + 1}`,
    }));
    const chain = GraphModel.empty().upsertNodes(nodes).upsertEdges(edges);
    const layouts = new GraphLayouts();
    // This would stack-overflow with a naive recursive DFS; it must complete cleanly.
    const result = layouts.compute('tree', chain);
    assert.equal(result.positions.length, NODE_COUNT);
    const depthOf = new Map(result.positions.map((p) => [p.id, p.position.y]));
    assert.ok(depthOf.get('c0') < depthOf.get(`c${NODE_COUNT - 1}`));
});
test('filters narrow a 100k/500k graph in linear time', () => {
    const start = Date.now();
    const filtered = GraphFilters.empty().withNodeTypes(['hub']).apply(graph);
    const elapsedMs = Date.now() - start;
    assert.ok(filtered.nodeCount > 0 && filtered.nodeCount < NODE_COUNT);
    assert.ok(elapsedMs < 5_000, `filtering took too long: ${elapsedMs}ms`);
});
test('viewport culling keeps the rendered frame small at 100k/500k scale', () => {
    const start = Date.now();
    const renderer = new GraphRenderer(new SvgStringAdapter());
    const frame = renderer.buildFrame(graph, GraphTheme.light(), new GraphViewport({ x: 0, y: 0, zoom: 1 }), { width: 1000, height: 800 });
    const elapsedMs = Date.now() - start;
    assert.ok(frame.nodes.length < NODE_COUNT / 10, `culled frame should be far smaller than the full graph, got ${frame.nodes.length}`);
    assert.ok(elapsedMs < 10_000, `render culling took too long: ${elapsedMs}ms`);
});
test('search stays linear across 100k nodes / 500k edges', () => {
    const start = Date.now();
    const result = GraphSearch.run('Node 99999', graph);
    const elapsedMs = Date.now() - start;
    assert.equal(result.result.matches.length, 1);
    assert.ok(elapsedMs < 5_000, `search took too long: ${elapsedMs}ms`);
});
test('minimap geometry computes in linear time at scale', () => {
    const start = Date.now();
    const geometry = GraphMinimap.geometry(graph, new GraphViewport(), { width: 800, height: 600 }, { width: 200, height: 150 });
    const elapsedMs = Date.now() - start;
    assert.ok(geometry.worldBounds.width > 0);
    assert.ok(elapsedMs < 5_000, `minimap geometry took too long: ${elapsedMs}ms`);
});
test('controller can hold and query the full stress graph', () => {
    const controller = new GraphController({ model: graph });
    assert.equal(controller.getState().model.nodeCount, NODE_COUNT);
    controller.selectNode('n0');
    assert.ok(controller.getState().selection.hasNode('n0'));
});
//# sourceMappingURL=stress-100k.test.js.map