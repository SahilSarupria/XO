import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 10, y: 0 } })
    .upsertEdge({ id: 'e1', type: 'link', source: 'a', target: 'b' });
}

test('upsertNode is immutable and preserves deterministic order', () => {
  const m1 = GraphModel.empty();
  const m2 = m1.upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } });
  assert.equal(m1.nodeCount, 0);
  assert.equal(m2.nodeCount, 1);
  const m3 = m2.upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 0, y: 0 } });
  const m4 = m3.upsertNode({ id: 'a', type: 't', label: 'A2', position: { x: 1, y: 1 } });
  assert.deepEqual(m4.nodes.map((n) => n.id), ['a', 'b']);
  assert.equal(m4.getNode('a')?.label, 'A2');
});

test('removeNode cascades to incident edges', () => {
  const model = sample();
  const next = model.removeNode('a');
  assert.equal(next.nodeCount, 1);
  assert.equal(next.edgeCount, 0);
  assert.equal(model.edgeCount, 1, 'original model must be untouched');
});

test('edgesOf and neighborsOf', () => {
  const model = sample();
  assert.equal(model.edgesOf('a').length, 1);
  assert.deepEqual(model.neighborsOf('a'), ['b']);
});

test('merge upserts nodes/edges from another model', () => {
  const base = sample();
  const patch = GraphModel.empty().upsertNode({ id: 'c', type: 't', label: 'C', position: { x: 20, y: 0 } });
  const merged = base.merge(patch);
  assert.equal(merged.nodeCount, 3);
  assert.equal(base.nodeCount, 2, 'base must be untouched');
});
