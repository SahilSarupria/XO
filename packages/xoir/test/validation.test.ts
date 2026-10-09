import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { validateGraph } from '../src/validation.js';

test('validateGraph reports valid for a well-formed graph', () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'capability', properties: { name: 'A', description: 'd' } });
  const report = validateGraph(graph);
  assert.equal(report.valid, true);
  assert.equal(report.issues.length, 0);
});

test('validateGraph flags a missing required property for a known kind', () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'capability', properties: { name: 'A' } as never });
  const report = validateGraph(graph);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.kind === 'missing_required_property' && i.message.includes('description')));
});

test('validateGraph does not require known properties for a custom node kind', () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'custom:jurisdiction-profile', properties: { anything: 'goes' } });
  const report = validateGraph(graph);
  assert.equal(report.valid, true);
});

test('validateGraph flags a hash mismatch after a node is tampered with', () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  const created = graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  assert.ok(created.ok);
  if (!created.ok) return;

  // Simulate a node whose hash no longer matches its content (e.g. corrupted storage).
  const tamperedGraph = XoirGraph.create(XoirGraphId('g2'));
  tamperedGraph.addNode({ ...created.value, properties: { statement: 'tampered', domain: 'd' } });
  const report = validateGraph(tamperedGraph);
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.kind === 'hash_mismatch'));
});

test('validateGraph flags an out-of-range confidence value', () => {
  const graph = XoirGraph.create(XoirGraphId('g'));
  const created = graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'knowledge', properties: { statement: 's', domain: 'd' }, confidence: 1.5 });
  assert.ok(created.ok);
  const report = validateGraph(graph);
  assert.ok(report.issues.some((i) => i.kind === 'invalid_confidence_range'));
});

test('validateGraph flags an unsupported schema version', () => {
  const graph = XoirGraph.create(XoirGraphId('g'), 999);
  const report = validateGraph(graph);
  assert.ok(report.issues.some((i) => i.kind === 'unsupported_schema_version'));
});