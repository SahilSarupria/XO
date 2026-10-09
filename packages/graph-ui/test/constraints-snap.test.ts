import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { ConstraintEngine } from '../src/constraints/ConstraintEngine.js';
import { SnapEngine } from '../src/snap/SnapEngine.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 40 } })
    .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 300, y: 0 }, size: { width: 100, height: 40 } })
    .upsertNode({ id: 'c', type: 't', label: 'C', position: { x: 600, y: 200 }, size: { width: 100, height: 40 } });
}

test('ConstraintEngine locks a single axis', () => {
  const engine = ConstraintEngine.empty().setConstraint('a', { lockedAxis: 'x' });
  const resolved = engine.resolve(sample(), new Map([['a', { x: 999, y: 50 }]]));
  assert.deepEqual(resolved.get('a'), { x: 0, y: 50 });
});

test('ConstraintEngine locks both axes to the original position', () => {
  const engine = ConstraintEngine.empty().setConstraint('a', { lockedAxis: 'both' });
  const resolved = engine.resolve(sample(), new Map([['a', { x: 999, y: 999 }]]));
  assert.deepEqual(resolved.get('a'), { x: 0, y: 0 });
});

test('ConstraintEngine.lockedPosition pins to an absolute point regardless of axis lock', () => {
  const engine = ConstraintEngine.empty().setConstraint('a', { lockedPosition: { x: 42, y: 42 } });
  const resolved = engine.resolve(sample(), new Map([['a', { x: 0, y: 0 }]]));
  assert.deepEqual(resolved.get('a'), { x: 42, y: 42 });
});

test('ConstraintEngine applies per-node grid snapping', () => {
  const engine = ConstraintEngine.empty().setConstraint('a', { gridSize: 50 });
  const resolved = engine.resolve(sample(), new Map([['a', { x: 123, y: 77 }]]));
  assert.deepEqual(resolved.get('a'), { x: 100, y: 100 });
});

test('ConstraintEngine enforces minimum spacing within a snap group', () => {
  const engine = ConstraintEngine.empty()
    .setConstraint('a', { snapGroupId: 'row', minSpacing: 150 })
    .setConstraint('b', { snapGroupId: 'row', minSpacing: 150 });
  const resolved = engine.resolve(sample(), new Map([['b', { x: 50, y: 0 }]])); // trying to move b too close to a
  const bPos = resolved.get('b')!;
  assert.ok(bPos.x >= 150);
});

test('setConstraint/clearConstraint/getConstraint are immutable', () => {
  const e0 = ConstraintEngine.empty();
  const e1 = e0.setConstraint('a', { lockedAxis: 'x' });
  assert.equal(e0.getConstraint('a'), undefined);
  assert.deepEqual(e1.getConstraint('a'), { lockedAxis: 'x' });
  const e2 = e1.clearConstraint('a');
  assert.equal(e2.getConstraint('a'), undefined);
});

test('ConstraintEngine.align centers the given nodes on the mean of one axis', () => {
  const model = sample();
  const result = ConstraintEngine.align(model, { kind: 'align', axis: 'y', nodeIds: ['a', 'b', 'c'] });
  const values = [...result.values()].map((p) => p.y);
  assert.ok(values.every((v) => v === values[0]));
});

test('ConstraintEngine.distribute spaces nodes evenly along an axis', () => {
  const model = sample();
  const result = ConstraintEngine.distribute(model, { kind: 'distribute', axis: 'x', nodeIds: ['a', 'b', 'c'] });
  const xs = [...result.values()].map((p) => p.x).sort((x, y) => x - y);
  const gap1 = xs[1]! - xs[0]!;
  const gap2 = xs[2]! - xs[1]!;
  assert.ok(Math.abs(gap1 - gap2) < 1e-6);
});

test('ConstraintEngine.applyPositions writes a resolved position map back onto the model', () => {
  const model = sample();
  const next = ConstraintEngine.applyPositions(model, new Map([['a', { x: 999, y: 999 }]]));
  assert.deepEqual(next.getNode('a')!.position, { x: 999, y: 999 });
  assert.deepEqual(model.getNode('a')!.position, { x: 0, y: 0 }, 'original model must be untouched');
});

test('SnapEngine.gridSnap rounds to the nearest grid cell', () => {
  const engine = new SnapEngine({ gridSize: 25 });
  assert.deepEqual(engine.gridSnap({ x: 12, y: 38 }), { x: 0, y: 50 });
});

test('SnapEngine.resolve snaps to a sibling node edge within the magnetic radius', () => {
  const engine = new SnapEngine({ magneticRadius: 15, gridSize: 1 });
  const model = sample(); // node a at x=0..100
  const result = engine.resolve(model, 'b', { x: 105, y: 0 }, { width: 100, height: 40 }); // near a's right edge (x=100)
  assert.ok(result.snapped);
  assert.equal(result.position.x, 100);
});

test('SnapEngine.resolve falls back to grid snap when nothing else is within range', () => {
  const engine = new SnapEngine({ magneticRadius: 5, gridSize: 50 });
  const model = sample();
  const result = engine.resolve(model, 'b', { x: 1234, y: 1234 }, { width: 100, height: 40 });
  assert.deepEqual(result.position, { x: 1250, y: 1250 });
});

test('SnapEngine.resolve honors custom guides', () => {
  const engine = new SnapEngine({ magneticRadius: 10, customGuides: [{ orientation: 'vertical', position: 77, source: 'custom', relatedNodeIds: [] }] });
  const model = sample();
  const result = engine.resolve(model, 'b', { x: 80, y: 500 }, { width: 100, height: 40 });
  assert.equal(result.position.x, 77);
});
