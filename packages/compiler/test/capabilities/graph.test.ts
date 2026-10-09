import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashCapabilityGraph, serializeCapabilityGraph, deserializeCapabilityGraph, findCapability, findRelationshipsFrom, findRelationshipsTo } from '../../src/capabilities/graph.js';
import type { CapabilityGraph, Capability, CapabilityRelationship } from '../../src/capabilities/types.js';
import { UNKNOWN_SIGNATURE } from '../../src/capabilities/types.js';

function cap(id: string, name: string): Capability {
  return {
    id: id as Capability['id'],
    canonicalName: name,
    aliases: [],
    description: '',
    category: 'action',
    confidence: 0.7,
    provenance: [],
    inputs: [],
    outputs: [],
    dependencies: [],
    requiredKnowledgeNodeIds: [],
    relatedConcepts: [],
    requiredPermissions: [],
    invocationHints: [],
    examples: [],
    signature: UNKNOWN_SIGNATURE,
    metadata: {},
  };
}
function rel(id: string, from: string, to: string): CapabilityRelationship {
  return { id, type: 'depends_on', fromCapabilityId: from as Capability['id'], toCapabilityId: to as Capability['id'], confidence: 0.6, provenance: [] };
}

test('hashCapabilityGraph is deterministic', () => {
  const graph: CapabilityGraph = { capabilities: [cap('a', 'A'), cap('b', 'B')], relationships: [rel('r1', 'a', 'b')] };
  assert.equal(hashCapabilityGraph(graph), hashCapabilityGraph(graph));
});

test('hashCapabilityGraph is insensitive to array order', () => {
  const g1: CapabilityGraph = { capabilities: [cap('a', 'A'), cap('b', 'B')], relationships: [rel('r1', 'a', 'b')] };
  const g2: CapabilityGraph = { capabilities: [cap('b', 'B'), cap('a', 'A')], relationships: [rel('r1', 'a', 'b')] };
  assert.equal(hashCapabilityGraph(g1), hashCapabilityGraph(g2));
});

test('hashCapabilityGraph changes with content', () => {
  const g1: CapabilityGraph = { capabilities: [cap('a', 'A')], relationships: [] };
  const g2: CapabilityGraph = { capabilities: [cap('a', 'A Changed')], relationships: [] };
  assert.notEqual(hashCapabilityGraph(g1), hashCapabilityGraph(g2));
});

test('hashCapabilityGraph returns a well-formed hash for an empty graph', () => {
  assert.match(hashCapabilityGraph({ capabilities: [], relationships: [] }), /^sha256:[0-9a-f]{64}$/);
});

test('serialize then deserialize round-trips with identical hash', () => {
  const graph: CapabilityGraph = { capabilities: [cap('a', 'A'), cap('b', 'B')], relationships: [rel('r1', 'a', 'b')] };
  const result = deserializeCapabilityGraph(serializeCapabilityGraph(graph));
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(hashCapabilityGraph(result.value), hashCapabilityGraph(graph));
});

test('serialized output is sorted by id', () => {
  const graph: CapabilityGraph = { capabilities: [cap('z', 'Z'), cap('a', 'A')], relationships: [] };
  const parsed = JSON.parse(serializeCapabilityGraph(graph));
  assert.deepEqual(parsed.capabilities.map((c: Capability) => c.id), ['a', 'z']);
});

test('deserializeCapabilityGraph fails cleanly on malformed JSON', () => {
  assert.equal(deserializeCapabilityGraph('not json {{{').ok, false);
});

test('deserializeCapabilityGraph fails cleanly on the wrong shape', () => {
  assert.equal(deserializeCapabilityGraph(JSON.stringify({ foo: 'bar' })).ok, false);
});

test('findCapability/findRelationshipsFrom/findRelationshipsTo work correctly', () => {
  const graph: CapabilityGraph = { capabilities: [cap('a', 'A'), cap('b', 'B')], relationships: [rel('r1', 'a', 'b')] };
  assert.equal(findCapability(graph, 'a')?.canonicalName, 'A');
  assert.equal(findCapability(graph, 'missing'), undefined);
  assert.equal(findRelationshipsFrom(graph, 'a').length, 1);
  assert.equal(findRelationshipsTo(graph, 'b').length, 1);
});
