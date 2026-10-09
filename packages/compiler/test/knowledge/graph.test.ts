import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashKnowledgeGraph, serializeKnowledgeGraph, deserializeKnowledgeGraph, findKnowledgeNode, findEdgesFrom, findEdgesTo } from '../../src/knowledge/graph.js';
import type { KnowledgeGraph, KnowledgeNode, KnowledgeEdge } from '../../src/knowledge/types.js';

function node(id: string, label: string): KnowledgeNode {
  return { id: id as KnowledgeNode['id'], semanticType: 'concept', canonicalLabel: label, aliases: [], confidence: 0.8, provenance: [], metadata: {} };
}
function edge(id: string, from: string, to: string): KnowledgeEdge {
  return { id, type: 'references', fromNodeId: from as KnowledgeEdge['fromNodeId'], toNodeId: to as KnowledgeEdge['toNodeId'], confidence: 0.7, provenance: [] };
}

test('hashKnowledgeGraph is deterministic for identical graphs', () => {
  const graph: KnowledgeGraph = { nodes: [node('a', 'A'), node('b', 'B')], edges: [edge('e1', 'a', 'b')] };
  assert.equal(hashKnowledgeGraph(graph), hashKnowledgeGraph(graph));
});

test('hashKnowledgeGraph is insensitive to node/edge array order', () => {
  const g1: KnowledgeGraph = { nodes: [node('a', 'A'), node('b', 'B')], edges: [edge('e1', 'a', 'b')] };
  const g2: KnowledgeGraph = { nodes: [node('b', 'B'), node('a', 'A')], edges: [edge('e1', 'a', 'b')] };
  assert.equal(hashKnowledgeGraph(g1), hashKnowledgeGraph(g2));
});

test('hashKnowledgeGraph changes when content changes', () => {
  const g1: KnowledgeGraph = { nodes: [node('a', 'A')], edges: [] };
  const g2: KnowledgeGraph = { nodes: [node('a', 'A Changed')], edges: [] };
  assert.notEqual(hashKnowledgeGraph(g1), hashKnowledgeGraph(g2));
});

test('hashKnowledgeGraph returns a well-formed hash for an empty graph', () => {
  const hash = hashKnowledgeGraph({ nodes: [], edges: [] });
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
});

test('serializeKnowledgeGraph then deserializeKnowledgeGraph round-trips', () => {
  const graph: KnowledgeGraph = { nodes: [node('a', 'A'), node('b', 'B')], edges: [edge('e1', 'a', 'b')] };
  const json = serializeKnowledgeGraph(graph);
  const result = deserializeKnowledgeGraph(json);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(hashKnowledgeGraph(result.value), hashKnowledgeGraph(graph));
});

test('serializeKnowledgeGraph output is sorted by id regardless of input order', () => {
  const graph: KnowledgeGraph = { nodes: [node('z', 'Z'), node('a', 'A')], edges: [] };
  const json = serializeKnowledgeGraph(graph);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.nodes.map((n: KnowledgeNode) => n.id), ['a', 'z']);
});

test('deserializeKnowledgeGraph fails cleanly on malformed JSON', () => {
  const result = deserializeKnowledgeGraph('not json {{{');
  assert.equal(result.ok, false);
});

test('deserializeKnowledgeGraph fails cleanly on the wrong shape', () => {
  const result = deserializeKnowledgeGraph(JSON.stringify({ foo: 'bar' }));
  assert.equal(result.ok, false);
});

test('findKnowledgeNode finds a node by id, undefined if missing', () => {
  const graph: KnowledgeGraph = { nodes: [node('a', 'A')], edges: [] };
  assert.equal(findKnowledgeNode(graph, 'a')?.canonicalLabel, 'A');
  assert.equal(findKnowledgeNode(graph, 'missing'), undefined);
});

test('findEdgesFrom/findEdgesTo filter correctly', () => {
  const graph: KnowledgeGraph = { nodes: [node('a', 'A'), node('b', 'B')], edges: [edge('e1', 'a', 'b')] };
  assert.equal(findEdgesFrom(graph, 'a').length, 1);
  assert.equal(findEdgesFrom(graph, 'b').length, 0);
  assert.equal(findEdgesTo(graph, 'b').length, 1);
});
