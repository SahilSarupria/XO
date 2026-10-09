import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphLayouts } from '../src/layout/GraphLayouts.js';
import { computeLayoutTransition, layoutTransitionPositionAt, renderTransitionFrame, isLayoutTransitionComplete, } from '../src/layout/transitions/LayoutTransition.js';
import { GraphCamera } from '../src/camera/GraphCamera.js';
import { GraphCameraGroup } from '../src/camera/GraphCameraGroup.js';
function sample() {
    return GraphModel.empty()
        .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } })
        .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 0, y: 0 } });
}
test('computeLayoutTransition only animates nodes whose position actually changed', () => {
    const fromModel = sample();
    const toModel = new GraphLayouts().apply('grid', fromModel, { columns: 2, spacingX: 100, spacingY: 100 });
    const transition = computeLayoutTransition(fromModel, toModel, 1000, 0);
    // node 'a' stays at (0,0) in both grid and original -> no animation seeded for it; 'b' moves.
    assert.deepEqual(layoutTransitionPositionAt(transition, 'a', 500), { x: 0, y: 0 });
    assert.notDeepEqual(layoutTransitionPositionAt(transition, 'b', 500), toModel.getNode('b').position);
});
test('layoutTransitionPositionAt interpolates and settles at the target position', () => {
    const fromModel = sample();
    const toModel = new GraphLayouts().apply('grid', fromModel, { columns: 2, spacingX: 100, spacingY: 100 });
    const transition = computeLayoutTransition(fromModel, toModel, 1000, 0, 'linear');
    const mid = layoutTransitionPositionAt(transition, 'b', 500);
    const end = layoutTransitionPositionAt(transition, 'b', 5000);
    assert.deepEqual(end, toModel.getNode('b').position);
    assert.notDeepEqual(mid, end);
});
test('renderTransitionFrame produces a full intermediate GraphModel', () => {
    const fromModel = sample();
    const toModel = new GraphLayouts().apply('grid', fromModel, { columns: 2, spacingX: 100, spacingY: 100 });
    const transition = computeLayoutTransition(fromModel, toModel, 1000, 0, 'linear');
    const frame = renderTransitionFrame(transition, 500);
    assert.equal(frame.nodeCount, 2);
    assert.notDeepEqual(frame.getNode('b').position, toModel.getNode('b').position);
});
test('isLayoutTransitionComplete reflects elapsed time against duration', () => {
    const transition = computeLayoutTransition(sample(), sample(), 1000, 0);
    assert.ok(!isLayoutTransitionComplete(transition, 500));
    assert.ok(isLayoutTransitionComplete(transition, 1000));
});
test('GraphCamera pan/zoom/fit delegate to GraphViewport and commit to history', () => {
    const camera = GraphCamera.create();
    const panned = camera.pan(10, 20);
    assert.deepEqual(panned.viewport.state, { x: 10, y: 20, zoom: 1 });
    assert.ok(panned.canUndo);
    const undone = panned.undo();
    assert.deepEqual(undone.viewport.state, { x: 0, y: 0, zoom: 1 });
});
test('GraphCamera bookmarks save/recall named viewport states', () => {
    const camera = GraphCamera.create().pan(50, 50).bookmark('spot');
    const movedAway = camera.pan(500, 500);
    assert.notDeepEqual(movedAway.viewport.state, { x: 50, y: 50, zoom: 1 });
    const recalled = movedAway.goToBookmark('spot');
    assert.deepEqual(recalled.viewport.state, { x: 50, y: 50, zoom: 1 });
});
test('GraphCamera.focus centers on a node like GraphViewport.zoomToNode', () => {
    const model = sample();
    const camera = GraphCamera.create().focus('a', model, { width: 800, height: 600 }, 1);
    const screen = camera.viewport.worldToScreen({ x: 60, y: 20 }); // center of default-sized node a
    assert.ok(Math.abs(screen.x - 400) < 1);
});
test('GraphCamera.travelTo seeds a viewport animation and reports completion', () => {
    const camera = GraphCamera.create();
    const { engine } = camera.travelTo({ x: 100, y: 100, zoom: 2 }, 1000, 0, 'linear');
    const mid = GraphCamera.animatedStateAt(engine, 500, camera.viewport.state);
    assert.deepEqual(mid, { x: 50, y: 50, zoom: 1.5 });
    assert.ok(!GraphCamera.isTravelComplete(engine, 500));
    assert.ok(GraphCamera.isTravelComplete(engine, 1000));
});
test('GraphCameraGroup links cameras so pan propagates to linked peers only', () => {
    let group = GraphCameraGroup.empty().addCamera('main').addCamera('minimap').addCamera('unlinked');
    group = group.link('main').link('minimap');
    group = group.pan('main', 10, 20);
    assert.deepEqual(group.getCamera('main').viewport.state, { x: 10, y: 20, zoom: 1 });
    assert.deepEqual(group.getCamera('minimap').viewport.state, { x: 10, y: 20, zoom: 1 }, 'linked camera should follow');
    assert.deepEqual(group.getCamera('unlinked').viewport.state, { x: 0, y: 0, zoom: 1 }, 'unlinked camera must not move');
});
test('GraphCameraGroup.unlink stops propagation', () => {
    let group = GraphCameraGroup.empty().addCamera('main').addCamera('minimap').link('main').link('minimap');
    group = group.unlink('minimap');
    group = group.pan('main', 10, 10);
    assert.deepEqual(group.getCamera('minimap').viewport.state, { x: 0, y: 0, zoom: 1 });
});
test('GraphCameraGroup.zoomBy propagates to linked cameras', () => {
    let group = GraphCameraGroup.empty().addCamera('main').addCamera('mini').link('main').link('mini');
    group = group.zoomBy('main', 2);
    assert.equal(group.getCamera('mini').viewport.state.zoom, 2);
});
//# sourceMappingURL=layout-transitions-camera.test.js.map