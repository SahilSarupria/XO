import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphSelection } from '../src/selection/GraphSelection.js';
import { GraphGrouping } from '../src/grouping/GraphGrouping.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNodes([
      { id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 40 } },
      { id: 'b', type: 't', label: 'B', position: { x: 200, y: 0 }, size: { width: 100, height: 40 } },
      { id: 'c', type: 't', label: 'C', position: { x: 0, y: 200 }, size: { width: 100, height: 40 } },
    ])
    .upsertNodeGroup({ id: 'g1', label: 'Group 1', nodeIds: ['a', 'b'] })
    .upsertNodeGroup({ id: 'g2', label: 'Group 2', nodeIds: ['c'], parentGroupId: 'g1' });
}

test('nestedChildren finds transitive child groups via parentGroupId', () => {
  const model = sample().upsertNodeGroup({ id: 'g3', label: 'Group 3', nodeIds: [], parentGroupId: 'g2' });
  const children = GraphGrouping.nestedChildren(model, 'g1');
  assert.deepEqual(children.map((g) => g.id).sort(), ['g2', 'g3']);
});

test('allMemberNodeIds includes members of nested child groups', () => {
  const model = sample();
  assert.deepEqual([...GraphGrouping.allMemberNodeIds(model, 'g1')].sort(), ['a', 'b', 'c']);
});

test('bounds computes the enclosing rect of all member nodes', () => {
  const model = sample();
  const bounds = GraphGrouping.bounds(model, 'g1')!;
  assert.equal(bounds.x, 0);
  assert.equal(bounds.y, 0);
  assert.ok(bounds.width >= 300);
  assert.ok(bounds.height >= 240);
});

test('bounds is undefined for a group with no resolvable members', () => {
  const model = GraphModel.empty().upsertNodeGroup({ id: 'empty', label: 'Empty', nodeIds: [] });
  assert.equal(GraphGrouping.bounds(model, 'empty'), undefined);
});

test('toggleCollapse flips the collapsed flag immutably', () => {
  const model = sample();
  const collapsed = GraphGrouping.toggleCollapse(model, 'g1');
  assert.equal(collapsed.getNodeGroup('g1')!.collapsed, true);
  assert.equal(model.getNodeGroup('g1')!.collapsed, undefined, 'original must be untouched');
  const expanded = GraphGrouping.toggleCollapse(collapsed, 'g1');
  assert.equal(expanded.getNodeGroup('g1')!.collapsed, false);
});

test('fromSelection creates a persisted group tagged with its kind', () => {
  const model = sample();
  const selection = GraphSelection.empty().selectNodes(['a', 'c']);
  const withGroup = GraphGrouping.fromSelection(model, selection, 'newGroup', 'My Selection', 'semantic');
  const group = withGroup.getNodeGroup('newGroup')!;
  assert.deepEqual([...group.nodeIds].sort(), ['a', 'c']);
  assert.equal(GraphGrouping.kindOf(group), 'semantic');
});

test('temporary() builds an ephemeral group without touching the model', () => {
  const group = GraphGrouping.temporary(['a', 'b'], 'Drag Group');
  assert.equal(GraphGrouping.kindOf(group), 'temporary');
  assert.deepEqual(group.nodeIds, ['a', 'b']);
});

test('translate moves every member node of a group (including nested) by a delta', () => {
  const model = sample();
  const moved = GraphGrouping.translate(model, 'g1', { x: 10, y: 20 });
  assert.deepEqual(moved.getNode('a')!.position, { x: 10, y: 20 });
  assert.deepEqual(moved.getNode('c')!.position, { x: 10, y: 220 }, 'nested group g2 member should also move');
  assert.deepEqual(model.getNode('a')!.position, { x: 0, y: 0 }, 'original model must be untouched');
});
