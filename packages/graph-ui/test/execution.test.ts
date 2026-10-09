import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphExecutionState } from '../src/execution/GraphExecutionState.js';

test('idle state defaults every node to pending', () => {
  const state = GraphExecutionState.idle();
  assert.equal(state.statusOf('a'), 'pending');
});

test('markActive/markCompleted/markFailed update status immutably', () => {
  const s0 = GraphExecutionState.idle();
  const s1 = s0.markActive('a');
  assert.equal(s0.statusOf('a'), 'pending', 'original must be untouched');
  assert.equal(s1.statusOf('a'), 'active');
  const s2 = s1.markCompleted('a');
  assert.equal(s2.statusOf('a'), 'completed');
  const s3 = s2.markFailed('b');
  assert.equal(s3.statusOf('b'), 'failed');
});

test('execution path records nodes as they go active, no duplicate consecutive entries', () => {
  const state = GraphExecutionState.idle().markActive('a').markCompleted('a').markActive('b').markActive('b');
  assert.deepEqual(state.path, ['a', 'b']);
});

test('animateEdge/stopAnimatingEdge toggle animated edge set', () => {
  const s0 = GraphExecutionState.idle().animateEdge('e1');
  assert.ok(s0.animatedEdgeIds.has('e1'));
  const s1 = s0.stopAnimatingEdge('e1');
  assert.ok(!s1.animatedEdgeIds.has('e1'));
});

test('reset returns to idle', () => {
  const state = GraphExecutionState.idle().markActive('a').animateEdge('e1').reset();
  assert.equal(state.statusOf('a'), 'pending');
  assert.equal(state.animatedEdgeIds.size, 0);
  assert.equal(state.path.length, 0);
});
