import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowGraphAdapter,
  GraphController,
  GraphCommandRegistry,
  GraphInspector,
  exportModelToJson,
  importModelFromJson,
  captureSnapshot,
  applySnapshot,
  GraphAnimationEngine,
  animateHighlight,
  highlightIntensityAt,
  HistoryStack,
} from '../src/index.js';

/** End-to-end pass through the whole public API surface: adapter -> layout
 * -> controller -> commands -> inspector -> export -> animation, all via
 * top-level `@xo/graph-ui` exports rather than reaching into src/ files. */
test('adapter -> controller -> commands -> inspector -> export -> animation, end to end', () => {
  const model = WorkflowGraphAdapter.toGraphModel({
    steps: [
      { id: 'start', label: 'Start', kind: 'step' },
      { id: 'decide', label: 'Decide', kind: 'decision' },
      { id: 'end', label: 'End', kind: 'step' },
    ],
    transitions: [
      { id: 't1', from: 'start', to: 'decide' },
      { id: 't2', from: 'decide', to: 'end', label: 'approved' },
    ],
  });

  const controller = new GraphController({ model });
  controller.applyLayout('hierarchical', { direction: 'LR' });
  assert.notDeepEqual(controller.getState().model.getNode('end')!.position, { x: 0, y: 0 });

  const commands = new GraphCommandRegistry();
  commands.execute('search', { controller }, { query: 'decide' });
  assert.ok(controller.getState().selection.hasNode('decide'));

  const inspectorData = GraphInspector.fromNode(controller.getState().model.getNode('decide')!);
  assert.equal(inspectorData.title, 'Decide');

  const json = exportModelToJson(controller.getState().model);
  const restored = importModelFromJson(json);
  assert.equal(restored.nodeCount, 3);

  const snapshot = captureSnapshot(controller.getState(), Date.now());
  const freshController = new GraphController();
  applySnapshot(freshController, snapshot);
  assert.equal(freshController.getState().model.nodeCount, 3);
  assert.ok(freshController.getState().selection.hasNode('decide'));

  const engine = animateHighlight(GraphAnimationEngine.empty(), 'decide', 1000, 0);
  assert.ok(highlightIntensityAt(engine, 'decide', 500) > 0.9);
});

test('undo/redo composes with layout + commands through the public API', () => {
  const model = WorkflowGraphAdapter.toGraphModel({
    steps: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    transitions: [{ id: 't1', from: 'a', to: 'b' }],
  });
  const controller = new GraphController({ model });
  controller.applyLayout('grid', { columns: 2, spacingX: 100, spacingY: 100 });
  const afterLayout = controller.getState().model.getNode('b')!.position;
  assert.ok(controller.canUndo);
  controller.undo();
  assert.deepEqual(controller.getState().model.getNode('b')!.position, { x: 0, y: 0 });
  controller.redo();
  assert.deepEqual(controller.getState().model.getNode('b')!.position, afterLayout);
});

test('a standalone HistoryStack composes fine alongside a GraphController', () => {
  const controller = new GraphController();
  const labelHistory = HistoryStack.init('created');
  controller.setModel(WorkflowGraphAdapter.toGraphModel({ steps: [{ id: 'a', label: 'A' }], transitions: [] }));
  const next = labelHistory.push('renamed');
  assert.equal(next.present, 'renamed');
  assert.equal(controller.getState().model.nodeCount, 1);
});

test('every top-level export used in this file actually comes from the public index barrel', () => {
  assert.equal(typeof WorkflowGraphAdapter.toGraphModel, 'function');
  assert.equal(typeof GraphController, 'function');
  assert.equal(typeof GraphCommandRegistry, 'function');
  assert.equal(typeof GraphInspector.fromNode, 'function');
  assert.equal(typeof exportModelToJson, 'function');
  assert.equal(typeof HistoryStack.init, 'function');
});
