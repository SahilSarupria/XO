import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphViewport, isRectVisible } from '../src/viewport/GraphViewport.js';
function sample() {
    return GraphModel.empty()
        .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 50 } })
        .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 500, y: 500 }, size: { width: 100, height: 50 } });
}
test('pan/zoomTo/zoomBy update state immutably', () => {
    const v0 = new GraphViewport();
    const v1 = v0.pan(10, 20);
    assert.deepEqual(v1.state, { x: 10, y: 20, zoom: 1 });
    assert.deepEqual(v0.state, { x: 0, y: 0, zoom: 1 }, 'original must be untouched');
    const v2 = v0.zoomTo(2);
    assert.equal(v2.state.zoom, 2);
    const v3 = v0.zoomBy(2);
    assert.equal(v3.state.zoom, 2);
});
test('zoom clamps to [0.05, 8]', () => {
    assert.equal(new GraphViewport().zoomTo(100).state.zoom, 8);
    assert.equal(new GraphViewport().zoomTo(0.0001).state.zoom, 0.05);
});
test('zoomTo with anchor keeps the world point under the anchor stationary', () => {
    const v0 = new GraphViewport({ x: 0, y: 0, zoom: 1 });
    const anchor = { x: 100, y: 100 };
    const worldBefore = v0.screenToWorld(anchor);
    const v1 = v0.zoomTo(2, anchor);
    const worldAfter = v1.screenToWorld(anchor);
    assert.ok(Math.abs(worldBefore.x - worldAfter.x) < 1e-9);
    assert.ok(Math.abs(worldBefore.y - worldAfter.y) < 1e-9);
});
test('fitToScreen frames all nodes', () => {
    const model = sample();
    const v = new GraphViewport().fitToScreen(model, { width: 800, height: 600 });
    const rect = v.visibleWorldRect({ width: 800, height: 600 });
    assert.ok(rect.x <= 0 && rect.y <= 0);
    assert.ok(rect.x + rect.width >= 600);
});
test('centerNode centers the target node on screen', () => {
    const model = sample();
    const v = new GraphViewport().centerNode('a', model, { width: 800, height: 600 });
    const screenPos = v.worldToScreen({ x: 50, y: 25 }); // center of node a
    assert.ok(Math.abs(screenPos.x - 400) < 1e-6);
    assert.ok(Math.abs(screenPos.y - 300) < 1e-6);
});
test('worldToScreen / screenToWorld are inverses', () => {
    const v = new GraphViewport({ x: 37, y: -12, zoom: 1.75 });
    const world = { x: 123, y: 456 };
    const roundTripped = v.screenToWorld(v.worldToScreen(world));
    assert.ok(Math.abs(roundTripped.x - world.x) < 1e-9);
    assert.ok(Math.abs(roundTripped.y - world.y) < 1e-9);
});
test('isRectVisible', () => {
    const viewportRect = { x: 0, y: 0, width: 100, height: 100 };
    assert.ok(isRectVisible({ x: 50, y: 50, width: 10, height: 10 }, viewportRect));
    assert.ok(!isRectVisible({ x: 200, y: 200, width: 10, height: 10 }, viewportRect));
    assert.ok(isRectVisible({ x: -5, y: -5, width: 10, height: 10 }, viewportRect), 'partial overlap counts as visible');
});
//# sourceMappingURL=viewport.test.js.map