import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphSelection } from '../src/selection/GraphSelection.js';
import { SmartSelection } from '../src/selection/SmartSelection.js';
import { SavedSelections } from '../src/selection/SavedSelections.js';
import { GraphExecutionState } from '../src/execution/GraphExecutionState.js';

function dag(): GraphModel {
  return GraphModel.empty()
    .upsertNodes([
      { id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } },
      { id: 'b', type: 't', label: 'B', position: { x: 100, y: 0 } },
      { id: 'c', type: 't', label: 'C', position: { x: 200, y: 0 } },
      { id: 'd', type: 't', label: 'D', position: { x: 300, y: 0 } },
      { id: 'isolated', type: 't', label: 'Isolated', position: { x: 1000, y: 1000 } },
    ])
    .upsertEdges([
      { id: 'e1', type: 'l', source: 'a', target: 'b' },
      { id: 'e2', type: 'l', source: 'b', target: 'c' },
      { id: 'e3', type: 'l', source: 'b', target: 'd' },
    ]);
}

test('connectedComponent finds all reachable nodes ignoring direction', () => {
  const component = SmartSelection.connectedComponent(dag(), 'c');
  assert.deepEqual([...component].sort(), ['a', 'b', 'c', 'd']);
});

test('connectedComponent of an isolated node is just itself', () => {
  assert.deepEqual(SmartSelection.connectedComponent(dag(), 'isolated'), ['isolated']);
});

test('upstream finds ancestors', () => {
  assert.deepEqual([...SmartSelection.upstream(dag(), 'd')].sort(), ['a', 'b']);
});

test('downstream / dependencyChain find descendants', () => {
  assert.deepEqual([...SmartSelection.downstream(dag(), 'a')].sort(), ['b', 'c', 'd']);
  assert.deepEqual(SmartSelection.downstream(dag(), 'a'), SmartSelection.dependencyChain(dag(), 'a'));
});

test('executionPath reads the execution state path', () => {
  const exec = GraphExecutionState.idle().markActive('a').markCompleted('a').markActive('b');
  assert.deepEqual(SmartSelection.executionPath(exec), ['a', 'b']);
});

test('group returns members of a NodeGroup, including nested via hierarchy', () => {
  const model = dag()
    .upsertNodeGroup({ id: 'g1', label: 'G1', nodeIds: ['a', 'b'] })
    .upsertNodeGroup({ id: 'g2', label: 'G2', nodeIds: ['c'], parentGroupId: 'g1' });
  assert.deepEqual([...SmartSelection.group(model, 'g1')].sort(), ['a', 'b']);
  assert.deepEqual([...SmartSelection.hierarchy(model, 'g1')].sort(), ['a', 'b', 'c']);
});

test('range selects a contiguous slice of the model deterministic order', () => {
  assert.deepEqual(SmartSelection.range(dag(), 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(SmartSelection.range(dag(), 'd', 'b'), ['b', 'c', 'd'], 'order-independent');
});

test('invert returns every unselected node', () => {
  const model = dag();
  const selection = GraphSelection.empty().selectNode('a');
  const inverted = SmartSelection.invert(model, selection);
  assert.deepEqual([...inverted.state.nodeIds].sort(), ['b', 'c', 'd', 'isolated']);
});

test('expand grows the selection by one hop', () => {
  const model = dag();
  const selection = GraphSelection.empty().selectNode('b');
  const expanded = SmartSelection.expand(model, selection);
  assert.deepEqual([...expanded.state.nodeIds].sort(), ['a', 'b', 'c', 'd']);
});

test('contract shrinks to the interior of the selection', () => {
  const model = dag();
  const selection = GraphSelection.empty().selectNodes(['a', 'b', 'c']); // d not selected, so b's neighbor set isn't fully covered
  const contracted = SmartSelection.contract(model, selection);
  assert.ok(!contracted.hasNode('b'), 'b has neighbor d which is unselected, so b is not interior');
});

test('SavedSelections save/get/remove/has are immutable and named', () => {
  const s0 = SavedSelections.empty();
  const selection = GraphSelection.empty().selectNode('a');
  const s1 = s0.save('my-selection', selection);
  assert.ok(!s0.has('my-selection'), 'original must be untouched');
  assert.ok(s1.has('my-selection'));
  assert.equal(s1.get('my-selection'), selection);
  const s2 = s1.remove('my-selection');
  assert.ok(!s2.has('my-selection'));
  assert.deepEqual(s1.names, ['my-selection']);
});
