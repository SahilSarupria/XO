// UW-1: deterministic content hashing (createdAt is bookkeeping, not content) and verified loading across trust boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph } from '../src/graph.js';
import { XoirGraphId, XoirNodeId, XoirEdgeId } from '../src/ids.js';
import { hashNode, hashNodeLegacyV1, nodeHashScheme, verifyNodeHash, verifyEdgeHash, hashEdgeLegacyV1 } from '../src/hashing.js';
import { fromJson, toJson, xoirGraphCodec } from '../src/serialization.js';
import type { XoirNode } from '../src/node-kinds.js';

function nodeOf(g: XoirGraph, id: string): XoirNode {
  const r = g.getNode(XoirNodeId(id));
  assert.ok(r.ok);
  return r.value;
}

function graph(at: string): XoirGraph {
  const g = XoirGraph.create(XoirGraphId('g'));
  const now = () => at;
  g.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'refund' }, now });
  g.createAndAddNode({ id: XoirNodeId('b'), kind: 'concept', properties: { definition: 'escalation' }, now });
  const e = g.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'DEPENDS_ON', fromId: XoirNodeId('a'), toId: XoirNodeId('b'), now });
  assert.ok(e.ok);
  return g;
}

test('the same content created at different times has the same node, edge and graph hash', () => {
  const g1 = graph('2026-01-01T00:00:00.000Z');
  const g2 = graph('2026-11-13T09:30:00.123Z');
  assert.equal(nodeOf(g1, 'a').hash, nodeOf(g2, 'a').hash);
  assert.equal([...g1.allEdges()][0]?.hash, [...g2.allEdges()][0]?.hash);
  assert.equal(g1.contentHash(), g2.contentHash());
  assert.notEqual(nodeOf(g1, 'a').metadata.createdAt, nodeOf(g2, 'a').metadata.createdAt, 'createdAt is still recorded');
});

test('different content still has a different hash', () => {
  const g = XoirGraph.create(XoirGraphId('g'));
  const a = g.createAndAddNode({ id: XoirNodeId('a'), kind: 'concept', properties: { definition: 'refund' } });
  const b = g.createAndAddNode({ id: XoirNodeId('b'), kind: 'concept', properties: { definition: 'refunds' } });
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) assert.notEqual(hashNode({ ...a.value, id: XoirNodeId('x') }), hashNode({ ...b.value, id: XoirNodeId('x') }));
});

test('a node stored before UW-1 (scheme-1 hash over createdAt) still verifies; any content change fails both schemes', () => {
  const node = nodeOf(graph('2026-01-01T00:00:00.000Z'), 'a');
  const legacy: XoirNode = { ...node, hash: hashNodeLegacyV1(node) };
  assert.notEqual(legacy.hash, node.hash);
  assert.equal(verifyNodeHash(legacy), true);
  const tampered: XoirNode = { ...legacy, properties: { definition: 'something else' } };
  assert.equal(verifyNodeHash(tampered), false);
  const reDated: XoirNode = { ...legacy, metadata: { ...legacy.metadata, createdAt: '2030-01-01T00:00:00.000Z' } };
  assert.equal(verifyNodeHash(reDated), false, 'a scheme-1 hash still covers the createdAt it was computed over');

  const edge = [...graph('2026-01-01T00:00:00.000Z').allEdges()][0]!;
  assert.equal(verifyEdgeHash({ ...edge, hash: hashEdgeLegacyV1(edge) }), true);
  assert.equal(verifyEdgeHash({ ...edge, toId: XoirNodeId('a') }), false);
});

test('fromJson({ verify: true }) rejects a tampered node or edge; without verify the in-memory round trip is unchanged', () => {
  const json = toJson(graph('2026-01-01T00:00:00.000Z'));
  assert.ok(fromJson(json, { verify: true }).ok);
  const badNode = { ...json, nodes: json.nodes.map((n) => (n.id === 'a' ? { ...n, properties: { definition: 'forged' } } : n)) };
  const r = fromJson(badNode, { verify: true });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error.code, 'XO_SERIALIZATION_INTEGRITY_FAILED');
  assert.ok(fromJson(badNode).ok, 'unverified loading keeps its documented behaviour');
  const badEdge = { ...json, edges: json.edges.map((e) => ({ ...e, fromId: e.toId })) };
  assert.equal(fromJson(badEdge, { verify: true }).ok, false);
});

test('the codec (the read path from storage) always verifies', () => {
  const text = xoirGraphCodec.encode(graph('2026-01-01T00:00:00.000Z'));
  assert.ok(xoirGraphCodec.decode(text).ok);
  const forged = text.replace('"refund"', '"forged"');
  assert.notEqual(forged, text);
  const r = xoirGraphCodec.decode(forged);
  assert.equal(r.ok, false);
});

test('a node holding undefined values hashes the same before and after it is stored as JSON', () => {
  const g = XoirGraph.create(XoirGraphId('g'));
  const r = g.createAndAddNode({
    id: XoirNodeId('u'),
    kind: 'concept',
    properties: { definition: 'x', optional: undefined, list: ['a', undefined] } as never,
  });
  assert.ok(r.ok);
  const stored = JSON.parse(JSON.stringify(toJson(g)));
  assert.ok(fromJson(stored, { verify: true }).ok, 'reading back what was written must verify');
});

test('graphs stored before UW-1 under the oldest scheme (no producedBy in the hash) still verify, and a change is still caught', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(new URL('../../../examples/e2e-pdf/output/compiled-xoir.json', import.meta.url), 'utf8'));
  const json = raw.graph ?? raw;
  assert.ok(fromJson(json, { verify: true }).ok);
  const node = json.nodes[0];
  assert.equal(nodeHashScheme(node), 'legacy-v0');
  assert.equal(nodeHashScheme({ ...node, properties: { ...node.properties, name: 'forged' } }), undefined);
  assert.equal(nodeHashScheme({ ...node, metadata: { ...node.metadata, producedBy: 'forged' } }), undefined, 'v0 never sealed producedBy');
});
