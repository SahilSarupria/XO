import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphModel } from '../src/model/GraphModel.js';
import { GraphViewport } from '../src/viewport/GraphViewport.js';
import { GraphTheme } from '../src/theme/GraphTheme.js';
import { GraphRenderer } from '../src/render/GraphRenderer.js';
import { SvgStringAdapter } from '../src/render/adapters/SvgStringAdapter.js';

function sample(): GraphModel {
  return GraphModel.empty()
    .upsertNode({ id: 'a', type: 't', label: 'A <script>', position: { x: 0, y: 0 } })
    .upsertNode({ id: 'b', type: 't', label: 'B', position: { x: 200, y: 0 } })
    .upsertEdge({ id: 'e1', type: 'l', source: 'a', target: 'b' });
}

test('renders valid SVG markup containing every node and edge', () => {
  const adapter = new SvgStringAdapter();
  const renderer = new GraphRenderer(adapter);
  renderer.render(sample(), GraphTheme.light(), new GraphViewport(), { width: 800, height: 600 });
  const svg = adapter.toString();
  assert.match(svg, /^<svg /);
  assert.match(svg, /data-node-id="a"/);
  assert.match(svg, /data-node-id="b"/);
  assert.match(svg, /data-edge-id="e1"/);
});

test('escapes label text to prevent markup injection', () => {
  const adapter = new SvgStringAdapter();
  const renderer = new GraphRenderer(adapter);
  renderer.render(sample(), GraphTheme.light(), new GraphViewport(), { width: 800, height: 600 });
  const svg = adapter.toString();
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('dispose clears the adapter output', () => {
  const adapter = new SvgStringAdapter();
  const renderer = new GraphRenderer(adapter);
  renderer.render(sample(), GraphTheme.light(), new GraphViewport(), { width: 800, height: 600 });
  renderer.dispose();
  assert.equal(adapter.toString(), '');
});
