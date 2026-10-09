import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { Quadtree } from '../src/spatial/Quadtree.js';
import { RTree } from '../src/spatial/RTree.js';
import { SpatialIndex } from '../src/spatial/SpatialIndex.js';

function grid(n: number, spacing = 50): GraphModel {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    type: 't',
    label: `${i}`,
    position: { x: (i % 20) * spacing, y: Math.floor(i / 20) * spacing },
    size: { width: 20, height: 20 },
  }));
  return GraphModel.empty().upsertNodes(nodes);
}

test('Quadtree.queryRect returns only entries intersecting the rect', () => {
  const entries = [
    { id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', rect: { x: 500, y: 500, width: 10, height: 10 } },
  ];
  const tree = Quadtree.build(entries);
  assert.deepEqual(tree.queryRect({ x: -5, y: -5, width: 20, height: 20 }), ['a']);
});

test('Quadtree.nearest finds the closest entry by center distance', () => {
  const entries = [
    { id: 'near', rect: { x: 10, y: 10, width: 2, height: 2 } },
    { id: 'far', rect: { x: 1000, y: 1000, width: 2, height: 2 } },
  ];
  const tree = Quadtree.build(entries);
  assert.equal(tree.nearest({ x: 12, y: 12 }), 'near');
});

test('Quadtree subdivides correctly with many entries above capacity', () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ id: `e${i}`, rect: { x: i, y: i, width: 1, height: 1 } }));
  const tree = Quadtree.build(entries, undefined, 8);
  const results = tree.queryRect({ x: 0, y: 0, width: 50, height: 50 });
  assert.ok(results.length > 0 && results.length <= 51);
});

test('RTree.queryRect matches Quadtree results for the same data', () => {
  const entries = [
    { id: 'a', rect: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'b', rect: { x: 500, y: 500, width: 10, height: 10 } },
    { id: 'c', rect: { x: 5, y: 5, width: 10, height: 10 } },
  ];
  const quad = Quadtree.build(entries);
  const rtree = RTree.build(entries);
  const rect = { x: -5, y: -5, width: 20, height: 20 };
  assert.deepEqual([...quad.queryRect(rect)].sort(), [...rtree.queryRect(rect)].sort());
});

test('RTree.nearest finds the closest entry', () => {
  const entries = [
    { id: 'near', rect: { x: 10, y: 10, width: 2, height: 2 } },
    { id: 'far', rect: { x: 1000, y: 1000, width: 2, height: 2 } },
  ];
  const tree = RTree.build(entries);
  assert.equal(tree.nearest({ x: 12, y: 12 }), 'near');
});

test('RTree.build handles an empty entry set', () => {
  const tree = RTree.build([]);
  assert.deepEqual(tree.queryRect({ x: 0, y: 0, width: 100, height: 100 }), []);
});

test('SpatialIndex.queryViewport / queryRegion return nodes intersecting a rect', () => {
  const model = grid(100);
  const index = SpatialIndex.build(model);
  const results = index.queryViewport({ x: 0, y: 0, width: 60, height: 60 });
  assert.ok(results.length > 0);
  for (const id of results) {
    const node = model.getNode(id)!;
    assert.ok(node.position.x < 60 && node.position.y < 60);
  }
});

test('SpatialIndex.collidingNodes excludes the given id', () => {
  const model = grid(10);
  const index = SpatialIndex.build(model);
  const results = index.collidingNodes({ x: 0, y: 0, width: 30, height: 30 }, 'n0');
  assert.ok(!results.includes('n0'));
});

test('SpatialIndex.nearestNode / nearestEdge work for both backends', () => {
  const model = GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 1000, y: 1000 } })
    .upsertEdge({ id: 'e1', type: 'l', source: 'a', target: 'b' });

  for (const backend of ['quadtree', 'rtree'] as const) {
    const index = SpatialIndex.build(model, backend);
    assert.equal(index.nearestNode({ x: 5, y: 5 }), 'a');
    assert.equal(index.nearestEdge({ x: 500, y: 500 }), 'e1');
  }
});

test('SpatialIndex.bounds reflects the built extent', () => {
  const model = grid(50);
  const index = SpatialIndex.build(model);
  assert.ok(index.bounds.width > 0 && index.bounds.height > 0);
});
