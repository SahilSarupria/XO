import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphViewport } from '../src/viewport/GraphViewport.js';
import { GraphMinimap } from '../src/minimap/GraphMinimap.js';
function sample() {
    return GraphModel.empty()
        .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 100 } })
        .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 1000, y: 1000 }, size: { width: 100, height: 100 } });
}
test('geometry computes world bounds spanning all nodes', () => {
    const geom = GraphMinimap.geometry(sample(), new GraphViewport(), { width: 800, height: 600 }, { width: 200, height: 150 });
    assert.ok(geom.worldBounds.width >= 1000);
    assert.ok(geom.worldBounds.height >= 1000);
});
test('viewport rect shrinks in minimap space as zoom increases', () => {
    const model = sample();
    const size = { width: 200, height: 150 };
    const low = GraphMinimap.geometry(model, new GraphViewport({ x: 0, y: 0, zoom: 1 }), { width: 800, height: 600 }, size);
    const high = GraphMinimap.geometry(model, new GraphViewport({ x: 0, y: 0, zoom: 4 }), { width: 800, height: 600 }, size);
    assert.ok(high.minimapViewportRect.width < low.minimapViewportRect.width);
});
test('navigateFromClick centers the viewport on the clicked world point', () => {
    const model = sample();
    const viewportSize = { width: 800, height: 600 };
    const minimapSize = { width: 200, height: 150 };
    const viewport = new GraphViewport({ x: 0, y: 0, zoom: 1 });
    const geom = GraphMinimap.geometry(model, viewport, viewportSize, minimapSize);
    const clickAtWorldOrigin = { x: geom.minimapWorldRect.x, y: geom.minimapWorldRect.y };
    const next = GraphMinimap.navigateFromClick(clickAtWorldOrigin, model, viewport, viewportSize, minimapSize);
    const screenOfWorldOrigin = next.worldToScreen({ x: geom.worldBounds.x, y: geom.worldBounds.y });
    assert.ok(Math.abs(screenOfWorldOrigin.x - viewportSize.width / 2) < 1);
    assert.ok(Math.abs(screenOfWorldOrigin.y - viewportSize.height / 2) < 1);
});
//# sourceMappingURL=minimap.test.js.map