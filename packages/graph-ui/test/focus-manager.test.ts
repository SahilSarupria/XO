import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { FocusManager } from '../src/interaction/FocusManager.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 100, y: 0 } })
    .upsertNode({ id: 'c', type: 't', label: 'C', position: { x: 200, y: 0 } });
}

test('focus/blur transitions immutably', () => {
  const f0 = FocusManager.none();
  assert.ok(!f0.isFocused);
  const f1 = f0.focus('a');
  assert.ok(f1.isFocused);
  assert.equal(f1.state.focusedNodeId, 'a');
  assert.ok(!f0.isFocused, 'original must be untouched');
  const f2 = f1.blur();
  assert.ok(!f2.isFocused);
});

test('tabOrder matches the model deterministic node order', () => {
  assert.deepEqual(FocusManager.tabOrder(sample()), ['a', 'b', 'c']);
});

test('focusNext advances through tab order and wraps', () => {
  const model = sample();
  const f1 = FocusManager.none().focusNext(model);
  assert.equal(f1.state.focusedNodeId, 'a');
  const f2 = f1.focusNext(model);
  assert.equal(f2.state.focusedNodeId, 'b');
  const f3 = f2.focusNext(model).focusNext(model);
  assert.equal(f3.state.focusedNodeId, 'a', 'wraps around after c');
});

test('focusNext(reverse) walks backward and wraps to the last node', () => {
  const model = sample();
  const f1 = FocusManager.none().focusNext(model, true);
  assert.equal(f1.state.focusedNodeId, 'c');
  const f2 = f1.focusNext(model, true);
  assert.equal(f2.state.focusedNodeId, 'b');
});

test('focusDirectional moves spatially and stays put with no neighbor that way', () => {
  const model = sample();
  const f1 = FocusManager.none().focus('a').focusDirectional(model, 'right');
  assert.equal(f1.state.focusedNodeId, 'b');
  const f2 = f1.focusDirectional(model, 'up');
  assert.equal(f2.state.focusedNodeId, 'b', 'no neighbor above, focus stays put');
});
