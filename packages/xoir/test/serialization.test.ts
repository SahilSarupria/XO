import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { fromJson, toJson, xoirGraphCodec } from '../src/serialization.js';

function buildGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('ser'));
  graph.createAndAddNode({ id: XoirNodeId('a'), kind: 'capability', properties: { name: 'A', description: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('b'), kind: 'knowledge', properties: { statement: 's', domain: 'd' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('b') });
  return graph;
}

test('toJson produces nodes/edges sorted by id', () => {
  const json = toJson(buildGraph());
  assert.deepEqual(json.nodes.map((n) => n.id), ['a', 'b']);
});

test('fromJson(toJson(graph)) round-trips to an equivalent graph (same content hash)', () => {
  const graph = buildGraph();
  const roundTripped = fromJson(toJson(graph));
  assert.ok(roundTripped.ok);
  if (!roundTripped.ok) return;
  assert.equal(roundTripped.value.contentHash(), graph.contentHash());
  assert.equal(roundTripped.value.stats().nodeCount, 2);
});

test('fromJson rejects an unsupported schemaVersion', () => {
  const json = toJson(buildGraph());
  const result = fromJson({ ...json, schemaVersion: 999 });
  assert.equal(result.ok, false);
});

test('xoirGraphCodec.decode(xoirGraphCodec.encode(graph)) round-trips through a string', () => {
  const graph = buildGraph();
  const encoded = xoirGraphCodec.encode(graph);
  assert.equal(typeof encoded, 'string');
  const decoded = xoirGraphCodec.decode(encoded);
  assert.ok(decoded.ok);
  if (!decoded.ok) return;
  assert.equal(decoded.value.contentHash(), graph.contentHash());
});

test('xoirGraphCodec.decode fails cleanly on malformed input', () => {
  const decoded = xoirGraphCodec.decode('not json at all {{{');
  assert.equal(decoded.ok, false);
});
// --- P0.9A area A: producer attribution / review status round-trip ---

test('metadata.producedBy and metadata.reviewStatus round-trip through toJson/fromJson', () => {
  const graph = XoirGraph.create(XoirGraphId('ser2'));
  graph.createAndAddNode({ id: XoirNodeId('c'), kind: 'capability', properties: { name: 'C', description: 'd' }, producedBy: 'structured-operation', reviewStatus: 'human_confirmed' });
  const roundTripped = fromJson(toJson(graph));
  assert.ok(roundTripped.ok);
  if (!roundTripped.ok) return;
  const node = roundTripped.value.getNode(XoirNodeId('c'));
  assert.ok(node.ok);
  if (!node.ok) return;
  assert.equal(node.value.metadata.producedBy, 'structured-operation');
  assert.equal(node.value.metadata.reviewStatus, 'human_confirmed');
});

test('a node with no producedBy/reviewStatus round-trips with both fields absent (legacy-graph backward compatibility)', () => {
  const graph = buildGraph();
  const roundTripped = fromJson(toJson(graph));
  assert.ok(roundTripped.ok);
  if (!roundTripped.ok) return;
  const node = roundTripped.value.getNode(XoirNodeId('a'));
  assert.ok(node.ok);
  if (!node.ok) return;
  assert.equal(node.value.metadata.producedBy, undefined);
  assert.equal(node.value.metadata.reviewStatus, undefined);
});
