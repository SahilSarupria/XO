import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { SpatialIndex } from '../src/spatial/SpatialIndex.js';

function denseGrid(n: number, spacing: number): GraphModel {
  const columns = Math.ceil(Math.sqrt(n));
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    type: 't',
    label: `${i}`,
    position: { x: (i % columns) * spacing, y: Math.floor(i / columns) * spacing },
    size: { width: 20, height: 20 },
  }));
  return GraphModel.empty().upsertNodes(nodes);
}

test('Quadtree stays fast and bounded even when node bounds are large relative to spacing (degenerate-overlap case)', () => {
  // Deliberately oversized rects (120x40 default) far larger than 10px
  // spacing — this is exactly the shape that used to blow up the naive
  // quadtree via exponential duplicate-entry subdivision.
  const nodes = Array.from({ length: 20_000 }, (_, i) => ({
    id: `n${i}`,
    type: 't',
    label: `${i}`,
    position: { x: (i % 200) * 10, y: Math.floor(i / 200) * 10 },
  }));
  const model = GraphModel.empty().upsertNodes(nodes);
  const start = Date.now();
  const index = SpatialIndex.build(model, 'quadtree');
  const elapsedMs = Date.now() - start;
  assert.ok(elapsedMs < 10_000, `quadtree build took too long: ${elapsedMs}ms`);
  const results = index.queryViewport({ x: 0, y: 0, width: 100, height: 100 });
  assert.ok(results.length > 0);
});

test('both backends build and query 100k nodes within a reasonable time budget', () => {
  const model = denseGrid(100_000, 30);
  for (const backend of ['quadtree', 'rtree'] as const) {
    const start = Date.now();
    const index = SpatialIndex.build(model, backend);
    const buildMs = Date.now() - start;
    assert.ok(buildMs < 15_000, `${backend} build took too long: ${buildMs}ms`);

    const queryStart = Date.now();
    const results = index.queryViewport({ x: 0, y: 0, width: 300, height: 300 });
    const queryMs = Date.now() - queryStart;
    assert.ok(results.length > 0);
    assert.ok(queryMs < 2_000, `${backend} query took too long: ${queryMs}ms`);

    const nearest = index.nearestNode({ x: 5, y: 5 });
    assert.ok(nearest);
  }
});
