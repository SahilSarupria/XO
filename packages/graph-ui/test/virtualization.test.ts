import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { SpatialIndex } from '../src/spatial/SpatialIndex.js';
import { VirtualizationEngine } from '../src/virtualization/VirtualizationEngine.js';

function grid(n: number, spacing = 50): GraphModel {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `n${i}`,
    type: 't',
    label: `${i}`,
    position: { x: (i % 20) * spacing, y: Math.floor(i / 20) * spacing },
  }));
  return GraphModel.empty().upsertNodes(nodes);
}

test('lodForZoom returns full/simplified/dot at the right thresholds', () => {
  const engine = new VirtualizationEngine({ fullDetailZoom: 0.6, simplifiedZoom: 0.2 });
  assert.equal(engine.lodForZoom(1), 'full');
  assert.equal(engine.lodForZoom(0.4), 'simplified');
  assert.equal(engine.lodForZoom(0.05), 'dot');
});

test('importanceScore is higher for higher-degree nodes', () => {
  const model = GraphModel.empty()
    .upsertNodes([
      { id: 'hub', type: 't', label: 'H', position: { x: 0, y: 0 } },
      { id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 } },
      { id: 'b', type: 't', label: 'B', position: { x: 0, y: 0 } },
      { id: 'leaf', type: 't', label: 'L', position: { x: 0, y: 0 } },
    ])
    .upsertEdges([
      { id: 'e1', type: 'l', source: 'hub', target: 'a' },
      { id: 'e2', type: 'l', source: 'hub', target: 'b' },
    ]);
  const engine = new VirtualizationEngine();
  assert.ok(engine.importanceScore(model, 'hub') > engine.importanceScore(model, 'leaf'));
});

test('cluster buckets nodes deterministically by grid cell', () => {
  const model = grid(100, 10);
  const engine = new VirtualizationEngine({ clusterCellSize: 100 });
  const ids = model.nodes.map((n) => n.id);
  const clusters = engine.cluster(model, ids);
  const totalClustered = clusters.reduce((sum, c) => sum + c.count, 0);
  assert.equal(totalClustered, 100);
  assert.ok(clusters.length < 100, 'clustering should reduce the item count');
});

test('computeVisible culls via the spatial index and clusters only when over threshold at dot LOD', () => {
  const model = grid(5000, 20);
  const spatialIndex = SpatialIndex.build(model);
  const engine = new VirtualizationEngine({ clusterThreshold: 10 });
  const result = engine.computeVisible(model, spatialIndex, { x: -10000, y: -10000, width: 20000, height: 20000 }, 0.01);
  assert.equal(result.lod, 'dot');
  assert.ok(result.clusters && result.clusters.length > 0);
});

test('computeVisible does not cluster at full LOD even with many visible nodes', () => {
  const model = grid(5000, 20);
  const spatialIndex = SpatialIndex.build(model);
  const engine = new VirtualizationEngine({ clusterThreshold: 10 });
  const result = engine.computeVisible(model, spatialIndex, { x: -10000, y: -10000, width: 20000, height: 20000 }, 1);
  assert.equal(result.lod, 'full');
  assert.equal(result.clusters, undefined);
});

test('predictiveViewport expands the rect in the direction of travel', () => {
  const engine = new VirtualizationEngine();
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const expanded = engine.predictiveViewport(rect, { x: 1, y: 0 }, 50);
  assert.ok(expanded.width > rect.width);
  assert.equal(expanded.x, 0, 'moving right should not expand backward');
});

test('VirtualizationEngine.diff computes entered/exited between two visible sets', () => {
  const diff = VirtualizationEngine.diff(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepEqual(diff.entered, ['d']);
  assert.deepEqual(diff.exited, ['a']);
});
