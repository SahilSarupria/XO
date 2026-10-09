import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphController } from '../src/controller/GraphController.js';
function sample() {
    return GraphModel.empty()
        .upsertNode({ id: 'a', type: 'service', label: 'Alpha', position: { x: 0, y: 0 } })
        .upsertNode({ id: 'b', type: 'database', label: 'Beta', position: { x: 100, y: 0 } })
        .upsertEdge({ id: 'e1', type: 'link', source: 'a', target: 'b' });
}
test('setModel replaces the model and notifies subscribers', () => {
    const controller = new GraphController();
    let notifications = 0;
    controller.subscribe(() => notifications++);
    controller.setModel(sample());
    assert.equal(controller.getState().model.nodeCount, 2);
    assert.equal(notifications, 1);
});
test('selectNode / clearSelection update selection state', () => {
    const controller = new GraphController({ model: sample() });
    controller.selectNode('a');
    assert.ok(controller.getState().selection.hasNode('a'));
    controller.clearSelection();
    assert.ok(controller.getState().selection.isEmpty);
});
test('applyLayout mutates node positions via the registered layout engine', () => {
    const controller = new GraphController({ model: sample() });
    controller.applyLayout('grid', { columns: 2, spacingX: 100, spacingY: 100 });
    assert.deepEqual(controller.getState().model.getNode('b').position, { x: 100, y: 0 });
});
test('updateFilters narrows visibleModel without touching the underlying model', () => {
    const controller = new GraphController({ model: sample() });
    controller.updateFilters((f) => f.withNodeTypes(['service']));
    assert.equal(controller.visibleModel.nodeCount, 1);
    assert.equal(controller.getState().model.nodeCount, 2, 'base model must be unaffected by filters');
});
test('search selects the first match', () => {
    const controller = new GraphController({ model: sample() });
    controller.search('beta');
    assert.ok(controller.getState().selection.hasNode('b'));
});
test('nextMatch/previousMatch cycle and update selection', () => {
    const controller = new GraphController({
        model: GraphModel.empty()
            .upsertNode({ id: 'x1', type: 't', label: 'svc-1', position: { x: 0, y: 0 } })
            .upsertNode({ id: 'x2', type: 't', label: 'svc-2', position: { x: 0, y: 0 } }),
    });
    controller.search('svc');
    const first = [...controller.getState().selection.state.nodeIds][0];
    controller.nextMatch();
    const second = [...controller.getState().selection.state.nodeIds][0];
    assert.notEqual(first, second);
});
test('updateExecution mutates execution state through the controller', () => {
    const controller = new GraphController({ model: sample() });
    controller.updateExecution((exec) => exec.markActive('a'));
    assert.equal(controller.getState().execution.statusOf('a'), 'active');
    controller.resetExecution();
    assert.equal(controller.getState().execution.statusOf('a'), 'pending');
});
test('unsubscribe stops further notifications', () => {
    const controller = new GraphController();
    let count = 0;
    const unsubscribe = controller.subscribe(() => count++);
    controller.setModel(sample());
    unsubscribe();
    controller.selectNode('a');
    assert.equal(count, 1);
});
test('setModel/updateModel/applyLayout commit to undo history', () => {
    const controller = new GraphController();
    assert.ok(!controller.canUndo);
    controller.setModel(sample());
    assert.ok(controller.canUndo);
    controller.updateModel((m) => m.upsertNode({ id: 'c', type: 't', label: 'C', position: { x: 0, y: 0 } }));
    assert.equal(controller.getState().model.nodeCount, 3);
    controller.undo();
    assert.equal(controller.getState().model.nodeCount, 2);
    controller.undo();
    assert.equal(controller.getState().model.nodeCount, 0);
    assert.ok(!controller.canUndo);
});
test('redo re-applies an undone model change', () => {
    const controller = new GraphController();
    controller.setModel(sample());
    controller.undo();
    assert.equal(controller.getState().model.nodeCount, 0);
    assert.ok(controller.canRedo);
    controller.redo();
    assert.equal(controller.getState().model.nodeCount, 2);
    assert.ok(!controller.canRedo);
});
test('a new setModel after undo discards the redo branch', () => {
    const controller = new GraphController();
    controller.setModel(sample());
    controller.undo();
    controller.setModel(GraphModel.empty().upsertNode({ id: 'z', type: 't', label: 'Z', position: { x: 0, y: 0 } }));
    assert.ok(!controller.canRedo);
    assert.equal(controller.getState().model.nodeCount, 1);
});
test('applyLayout is also undoable', () => {
    const controller = new GraphController({ model: sample() });
    controller.applyLayout('grid', { columns: 2, spacingX: 50, spacingY: 50 });
    const laidOut = controller.getState().model.getNode('b').position;
    assert.notDeepEqual(laidOut, { x: 100, y: 0 });
    controller.undo();
    assert.deepEqual(controller.getState().model.getNode('b').position, { x: 100, y: 0 });
});
//# sourceMappingURL=controller.test.js.map