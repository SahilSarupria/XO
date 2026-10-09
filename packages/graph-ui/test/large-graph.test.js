import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphViewport } from '../src/viewport/GraphViewport.js';
import { GraphTheme } from '../src/theme/GraphTheme.js';
import { GraphRenderer } from '../src/render/GraphRenderer.js';
import { SvgStringAdapter } from '../src/render/adapters/SvgStringAdapter.js';
import { GraphLayouts } from '../src/layout/GraphLayouts.js';
function buildLargeGraph(nodeCount) {
    let model = GraphModel.empty();
    const nodes = Array.from({ length: nodeCount }, (_, i) => ({
        id: `n${i}`,
        type: 't',
        label: `Node ${i}`,
        // Spread nodes across a wide plane so only a fraction fall in any given viewport.
        position: { x: (i % 200) * 150, y: Math.floor(i / 200) * 150 },
    }));
    model = model.upsertNodes(nodes);
    const edges = Array.from({ length: nodeCount - 1 }, (_, i) => ({
        id: `e${i}`,
        type: 'l',
        source: `n${i}`,
        target: `n${i + 1}`,
    }));
    model = model.upsertEdges(edges);
    return model;
}
test('handles 10,000+ nodes without error', () => {
    const model = buildLargeGraph(10_000);
    assert.equal(model.nodeCount, 10_000);
    assert.equal(model.edgeCount, 9_999);
});
test('viewport culling renders far fewer nodes than exist once past the virtualization threshold', () => {
    const model = buildLargeGraph(10_000);
    const adapter = new SvgStringAdapter();
    const renderer = new GraphRenderer(adapter);
    const viewport = new GraphViewport({ x: 0, y: 0, zoom: 1 });
    const frame = renderer.render(model, GraphTheme.light(), viewport, { width: 800, height: 600 });
    assert.ok(frame.nodes.length < model.nodeCount, 'culled frame should contain far fewer nodes than the full model');
    assert.ok(frame.nodes.length > 0, 'something in the initial viewport should still render');
});
test('small graphs render fully even though nothing is on screen (below virtualization threshold)', () => {
    const model = GraphModel.empty().upsertNode({
        id: 'far',
        type: 't',
        label: 'Far away',
        position: { x: 100_000, y: 100_000 },
    });
    const adapter = new SvgStringAdapter();
    const renderer = new GraphRenderer(adapter);
    const frame = renderer.render(model, GraphTheme.light(), new GraphViewport(), { width: 800, height: 600 });
    assert.equal(frame.nodes.length, 1, 'below the virtualization threshold, culling is skipped entirely');
});
test('deterministic rendering order: two renders of the same model produce the same node id order', () => {
    const model = buildLargeGraph(500);
    const adapterA = new SvgStringAdapter();
    const adapterB = new SvgStringAdapter();
    const rendererA = new GraphRenderer(adapterA);
    const rendererB = new GraphRenderer(adapterB);
    const viewport = new GraphViewport({ x: 0, y: 0, zoom: 1 });
    const frameA = rendererA.render(model, GraphTheme.light(), viewport, { width: 800, height: 600 });
    const frameB = rendererB.render(model, GraphTheme.light(), viewport, { width: 800, height: 600 });
    assert.deepEqual(frameA.nodes.map((n) => n.node.id), frameB.nodes.map((n) => n.node.id));
});
test('grid layout stays fast and correct at 10,000 nodes', () => {
    const model = buildLargeGraph(10_000);
    const layouts = new GraphLayouts();
    const start = Date.now();
    const result = layouts.compute('grid', model, { columns: 100, spacingX: 50, spacingY: 50 });
    const elapsedMs = Date.now() - start;
    assert.equal(result.positions.length, 10_000);
    assert.ok(elapsedMs < 2000, `grid layout took too long: ${elapsedMs}ms`);
});
//# sourceMappingURL=large-graph.test.js.map