import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphController } from '../src/controller/GraphController.js';
import { GraphTheme } from '../src/theme/GraphTheme.js';
import { GraphViewport } from '../src/viewport/GraphViewport.js';
import { GraphRenderer } from '../src/render/GraphRenderer.js';
import { SvgStringAdapter } from '../src/render/adapters/SvgStringAdapter.js';
import type { RenderFrame } from '../src/render/adapters/GraphRenderAdapter.js';
import { exportToSvg, computeContentBounds } from '../src/export/toSvg.js';
import { exportToPng } from '../src/export/toPng.js';
import { exportModelToJson, importModelFromJson, modelToJsonObject, modelFromJsonObject } from '../src/export/toJson.js';
import { buildJsonClipboardPayload, buildSvgClipboardPayload } from '../src/export/clipboard.js';
import { captureSnapshot, exportSnapshotToJson, importSnapshotFromJson, applySnapshot } from '../src/export/snapshot.js';
import { exportToPrintSvg } from '../src/export/printExport.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'A', position: { x: 0, y: 0 }, size: { width: 100, height: 40 } })
    .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 200, y: 0 }, size: { width: 100, height: 40 } })
    .upsertEdge({ id: 'e1', type: 'l', source: 'a', target: 'b' });
}

function frameOf(model: GraphModel, theme = GraphTheme.light()): RenderFrame {
  const renderer = new GraphRenderer(new SvgStringAdapter());
  return renderer.buildFrame(model, theme, new GraphViewport(), { width: 800, height: 600 });
}

test('exportToSvg produces valid, bounded SVG markup', () => {
  const svg = exportToSvg(frameOf(sample()));
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox="/);
  assert.match(svg, /data-node-id="a"/);
});

test('computeContentBounds spans nodes and edge endpoints', () => {
  const bounds = computeContentBounds(frameOf(sample()));
  assert.ok(bounds.width >= 300);
});

test('exportToPng delegates SVG markup + dimensions to the supplied rasterizer', async () => {
  let capturedSvg = '';
  let capturedSize = { width: 0, height: 0 };
  const bytes = await exportToPng(frameOf(sample()), (svg, size) => {
    capturedSvg = svg;
    capturedSize = size;
    return new Uint8Array([1, 2, 3]);
  });
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.match(capturedSvg, /^<svg /);
  assert.ok(capturedSize.width > 0 && capturedSize.height > 0);
});

test('JSON export/import round-trips a model exactly', () => {
  const model = sample();
  const json = exportModelToJson(model);
  const restored = importModelFromJson(json);
  assert.equal(restored.nodeCount, model.nodeCount);
  assert.equal(restored.edgeCount, model.edgeCount);
  assert.deepEqual(restored.getNode('a'), model.getNode('a'));
});

test('modelToJsonObject / modelFromJsonObject round-trip without stringifying', () => {
  const model = sample();
  const restored = modelFromJsonObject(modelToJsonObject(model));
  assert.deepEqual(restored.nodes, model.nodes);
  assert.deepEqual(restored.edges, model.edges);
});

test('buildJsonClipboardPayload produces a JSON mime payload', () => {
  const payload = buildJsonClipboardPayload(sample());
  assert.equal(payload.mimeType, 'application/json');
  assert.ok(JSON.parse(payload.data));
});

test('buildSvgClipboardPayload produces an SVG mime payload', () => {
  const payload = buildSvgClipboardPayload(frameOf(sample()));
  assert.equal(payload.mimeType, 'image/svg+xml');
  assert.match(payload.data, /^<svg/);
});

test('snapshot capture/export/import/apply round-trips controller state', () => {
  const controller = new GraphController({ model: sample() });
  controller.selectNode('a');
  controller.setViewport({ x: 10, y: 20, zoom: 1.5 });

  const snapshot = captureSnapshot(controller.getState(), 1000);
  const json = exportSnapshotToJson(snapshot);
  const restoredSnapshot = importSnapshotFromJson(json);
  assert.equal(restoredSnapshot.version, 1);

  const freshController = new GraphController();
  applySnapshot(freshController, restoredSnapshot);
  assert.equal(freshController.getState().model.nodeCount, 2);
  assert.deepEqual(freshController.getState().viewport.state, { x: 10, y: 20, zoom: 1.5 });
  assert.ok(freshController.getState().selection.hasNode('a'));
});

test('exportToPrintSvg forces a white background regardless of theme', () => {
  const frame = frameOf(sample(), GraphTheme.dark());
  assert.notEqual(frame.background, '#ffffff');
  const printSvg = exportToPrintSvg(frame);
  assert.match(printSvg, /background:#ffffff/);
});
