import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphLayouts } from '../src/layout/GraphLayouts.js';
import { GraphDiagnostics } from '../src/diagnostics/GraphDiagnostics.js';
import { GraphCamera } from '../src/camera/GraphCamera.js';
import { GraphSelection } from '../src/selection/GraphSelection.js';
import { GraphAnimationEngine } from '../src/animation/GraphAnimationEngine.js';
import { HistoryStack } from '../src/history/HistoryStack.js';
import { DragStateMachine } from '../src/interaction/DragStateMachine.js';
import { ResizeStateMachine } from '../src/interaction/ResizeStateMachine.js';
import { HoverManager } from '../src/interaction/HoverManager.js';
import { FocusManager } from '../src/interaction/FocusManager.js';
import { inspectGraph, inspectInteraction, inspectSelection, inspectLayout, inspectCamera, inspectPerformance, inspectAnimation, inspectHistory, } from '../src/devtools/inspectors.js';
import { Timeline, EventTimeline, CommandTimeline } from '../src/devtools/Timeline.js';
function sample() {
    return GraphModel.empty()
        .upsertNodes([
        { id: 'a', type: 'service', label: 'A', position: { x: 0, y: 0 } },
        { id: 'b', type: 'service', label: 'B', position: { x: 100, y: 0 } },
        { id: 'c', type: 'database', label: 'C', position: { x: 200, y: 0 } },
    ])
        .upsertEdges([
        { id: 'e1', type: 'link', source: 'a', target: 'b' },
        { id: 'e2', type: 'link', source: 'b', target: 'c' },
    ]);
}
test('GraphDiagnostics.measure/timeLayout/timeSearch return a result + elapsed ms', () => {
    const model = sample();
    const sample1 = GraphDiagnostics.measure(() => 42);
    assert.equal(sample1.result, 42);
    assert.ok(sample1.ms >= 0);
    const layoutSample = GraphDiagnostics.timeLayout(new GraphLayouts(), 'grid', model, { columns: 2 });
    assert.equal(layoutSample.result.positions.length, 3);
    assert.ok(layoutSample.ms >= 0);
    const searchSample = GraphDiagnostics.timeSearch(model, 'A');
    assert.equal(searchSample.result.result.matches.length, 1);
});
test('GraphDiagnostics.estimateRenderCost scales with node/edge counts', () => {
    const small = GraphDiagnostics.estimateRenderCost({ nodes: new Array(10), edges: new Array(5) });
    const large = GraphDiagnostics.estimateRenderCost({ nodes: new Array(1000), edges: new Array(500) });
    assert.ok(large.estimatedMs > small.estimatedMs);
});
test('GraphDiagnostics.estimateMemory scales with graph size', () => {
    const est = GraphDiagnostics.estimateMemory(sample());
    assert.equal(est.nodeCount, 3);
    assert.equal(est.edgeCount, 2);
    assert.ok(est.estimatedBytes > 0);
});
test('GraphDiagnostics.hotspots filters and sorts by elapsed time descending', () => {
    const hotspots = GraphDiagnostics.hotspots({ layout: 50, search: 5, render: 200 }, 10);
    assert.deepEqual(hotspots.map((h) => h.name), ['render', 'layout']);
});
test('GraphDiagnostics.recommendations gives rule-based, deterministic advice', () => {
    const recs = GraphDiagnostics.recommendations({ nodeCount: 5000, edgeCount: 1000, activeLayoutKind: 'force-directed' });
    assert.ok(recs.some((r) => r.includes('force-directed')));
    const noRecs = GraphDiagnostics.recommendations({ nodeCount: 10, edgeCount: 5 });
    assert.deepEqual(noRecs, []);
});
test('inspectGraph summarizes node/edge type counts', () => {
    const snapshot = inspectGraph(sample());
    assert.equal(snapshot.nodeCount, 3);
    assert.equal(snapshot.edgeCount, 2);
    assert.deepEqual(snapshot.nodeTypeCounts, { service: 2, database: 1 });
    assert.deepEqual(snapshot.edgeTypeCounts, { link: 2 });
});
test('inspectInteraction aggregates the four interaction state machines', () => {
    const snapshot = inspectInteraction(DragStateMachine.idle().state, ResizeStateMachine.idle().state, HoverManager.none().state, FocusManager.none().state);
    assert.equal(snapshot.drag.phase, 'idle');
    assert.equal(snapshot.hover.kind, 'none');
});
test('inspectSelection summarizes a GraphSelection with a sample of node ids', () => {
    const selection = GraphSelection.empty().selectNodes(['a', 'b', 'c']);
    const snapshot = inspectSelection(selection, 2);
    assert.equal(snapshot.nodeCount, 3);
    assert.equal(snapshot.sampleNodeIds.length, 2);
});
test('inspectLayout reports available kinds and optional last-computed info', () => {
    const layouts = new GraphLayouts();
    const snapshot = inspectLayout(layouts.availableKinds, { kind: 'grid', ms: 3 });
    assert.ok(snapshot.availableKinds.includes('hierarchical'));
    assert.equal(snapshot.lastComputed?.kind, 'grid');
});
test('inspectCamera reads viewport/bookmarks/history off a GraphCamera', () => {
    const camera = GraphCamera.create().pan(5, 5).bookmark('spot');
    const snapshot = inspectCamera(camera);
    assert.deepEqual(snapshot.viewport, { x: 5, y: 5, zoom: 1 });
    assert.deepEqual(snapshot.bookmarkNames, ['spot']);
    assert.ok(snapshot.canUndo);
});
test('inspectPerformance composes render cost, memory, and recommendations', () => {
    const model = sample();
    const snapshot = inspectPerformance(model, { nodes: model.nodes.map((n) => ({ node: n })), edges: [] }, 'grid');
    assert.equal(snapshot.memory.nodeCount, 3);
    assert.ok(snapshot.renderCost.nodeCount >= 0);
});
test('inspectAnimation reports active animation ids and count', () => {
    const engine = GraphAnimationEngine.empty().start('a', 0, 1, 1000, 0);
    const snapshot = inspectAnimation(engine);
    assert.equal(snapshot.count, 1);
    assert.deepEqual(snapshot.activeIds, ['a']);
});
test('inspectHistory reports undo/redo availability and stack depths', () => {
    const history = HistoryStack.init('a').push('b').push('c').undo();
    const snapshot = inspectHistory(history);
    assert.ok(snapshot.canUndo);
    assert.ok(snapshot.canRedo);
    assert.equal(snapshot.pastLength, 1);
    assert.equal(snapshot.futureLength, 1);
});
test('Timeline.append is immutable, ordered, and capped', () => {
    const t0 = Timeline.empty(2);
    const t1 = t0.append('first', 100);
    const t2 = t1.append('second', 200);
    const t3 = t2.append('third', 300);
    assert.equal(t0.length, 0, 'original must be untouched');
    assert.equal(t3.length, 2, 'capped at limit');
    assert.deepEqual(t3.entries.map((e) => e.payload), ['second', 'third']);
});
test('Timeline.between filters by an inclusive time range', () => {
    const t = Timeline.empty().append('a', 0).append('b', 100).append('c', 200);
    const between = t.between(50, 150);
    assert.deepEqual(between.map((e) => e.payload), ['b']);
});
test('Timeline.last returns the most recent entry', () => {
    const t = Timeline.empty().append('a', 0).append('b', 100);
    assert.equal(t.last?.payload, 'b');
});
test('EventTimeline / CommandTimeline are specialized Timeline factories', () => {
    const events = EventTimeline.empty().append({ name: 'nodeClick', detail: { id: 'a' } }, 0);
    assert.equal(events.entries[0].payload.name, 'nodeClick');
    const commands = CommandTimeline.empty().append({ name: 'zoomIn', args: undefined }, 0);
    assert.equal(commands.entries[0].payload.name, 'zoomIn');
});
//# sourceMappingURL=diagnostics-devtools.test.js.map