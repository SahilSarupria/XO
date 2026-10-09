import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphController } from '../src/controller/GraphController.js';
import { GraphCommandRegistry, BUILTIN_COMMAND_NAMES } from '../src/commands/GraphCommandRegistry.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'Alpha', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'b', type: 't', label: 'Beta', position: { x: 100, y: 0 } })
    .upsertNode({ id: 'c', type: 't', label: 'Gamma', position: { x: 200, y: 0 }, groupId: 'g1' });
}

test('registry ships all ten built-in commands', () => {
  const registry = new GraphCommandRegistry();
  for (const name of BUILTIN_COMMAND_NAMES) assert.ok(registry.has(name), `missing command: ${name}`);
  assert.equal(BUILTIN_COMMAND_NAMES.length, 10);
});

test('unknown command throws', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  assert.throws(() => registry.execute('doesNotExist', { controller }));
});

test('register adds a custom command', () => {
  const registry = new GraphCommandRegistry();
  let called = false;
  registry.register('customPing', () => {
    called = true;
  });
  registry.execute('customPing', { controller: new GraphController() });
  assert.ok(called);
});

test('zoomIn / zoomOut change viewport zoom in opposite directions', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  registry.execute('zoomIn', { controller });
  assert.ok(controller.getState().viewport.state.zoom > 1);
  const afterIn = controller.getState().viewport.state.zoom;
  registry.execute('zoomOut', { controller });
  registry.execute('zoomOut', { controller });
  assert.ok(controller.getState().viewport.state.zoom < afterIn);
});

test('fit requires a viewportSize in context', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  assert.throws(() => registry.execute('fit', { controller }));
  registry.execute('fit', { controller, viewportSize: { width: 800, height: 600 } });
});

test('center moves the viewport toward the target node', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  registry.execute('center', { controller, viewportSize: { width: 800, height: 600 } }, { nodeId: 'b' });
  const screen = controller.getState().viewport.worldToScreen({ x: 160, y: 20 }); // center of node b (100,0)+120x40 default size
  assert.ok(Math.abs(screen.x - 400) < 1);
});

test('search selects the first match via the controller', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  registry.execute('search', { controller }, { query: 'beta' });
  assert.ok(controller.getState().selection.hasNode('b'));
});

test('highlight replaces selection with the given node ids', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  controller.selectNode('c');
  registry.execute('highlight', { controller }, { nodeIds: ['a', 'b'] });
  assert.ok(controller.getState().selection.hasNode('a'));
  assert.ok(controller.getState().selection.hasNode('b'));
  assert.ok(!controller.getState().selection.hasNode('c'));
});

test('collapse then expand toggles a group in and out of the collapsed filter set', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  registry.execute('collapse', { controller }, { groupId: 'g1' });
  assert.ok(!controller.visibleModel.getNode('c'));
  registry.execute('expand', { controller }, { groupId: 'g1' });
  assert.ok(controller.visibleModel.getNode('c'));
});

test('selectAll selects every currently visible node', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  registry.execute('selectAll', { controller });
  assert.equal(controller.getState().selection.state.nodeIds.size, 3);
});

test('clearSelection empties the selection', () => {
  const registry = new GraphCommandRegistry();
  const controller = new GraphController({ model: sample() });
  controller.selectNode('a');
  registry.execute('clearSelection', { controller });
  assert.ok(controller.getState().selection.isEmpty);
});
