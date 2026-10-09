import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { embedContractInCapabilityNode, embedResolvedContractInCapabilityNode } from '../src/contract-embed.js';
import { extractContractFromPropertyBag } from '../src/contract-extract.js';
import { buildSemanticCapabilityContract } from '../src/contract-builder.js';

function buildGraph(): XoirGraph {
  const graph = XoirGraph.create(XoirGraphId('g'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:claim-evaluation'),
    kind: 'capability',
    properties: { name: 'Evaluate Claim', description: 'Evaluates a submitted claim', determinism: 'deterministic' },
    tags: ['insurance'],
  });
  graph.createAndAddNode({
    id: XoirNodeId('decision:deny-large-claim'),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim', rationale: 'r' },
  });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('decision:deny-large-claim'), toId: XoirNodeId('capability:claim-evaluation') });
  return graph;
}

test('embeds a contract into the capability node and it is readable back via getNode', () => {
  const graph = buildGraph();
  const result = embedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.id, 'capability:claim-evaluation');
  const props = result.value.properties as { readonly semanticCapabilityContract?: { readonly id: string } };
  assert.equal(props.semanticCapabilityContract?.id, 'capability:claim-evaluation');
});

test('embedding preserves other node metadata (tags)', () => {
  const graph = buildGraph();
  const result = embedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.metadata.tags, ['insurance']);
});

test('extractContractFromPropertyBag round-trips the embedded contract with no @xo/xoir involved on this side', () => {
  const graph = buildGraph();
  const embedResult = embedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(embedResult.ok, true);
  if (!embedResult.ok) return;

  const extractResult = extractContractFromPropertyBag(embedResult.value.properties as Record<string, unknown>);
  assert.equal(extractResult.ok, true);
  if (!extractResult.ok) return;
  assert.equal(extractResult.value.id, 'capability:claim-evaluation');
  assert.equal(extractResult.value.rules.length, 1);
  assert.equal(extractResult.value.rules[0]!.outcome, 'deny the claim');
});

test('extractContractFromPropertyBag fails with CONTRACT_SOURCE_NODE_NOT_FOUND when the field is absent', () => {
  const result = extractContractFromPropertyBag({ name: 'Something', description: 'd' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_CONTRACT_SOURCE_NODE_NOT_FOUND');
});

test('extractContractFromPropertyBag fails with CONTRACT_MALFORMED for a malformed value', () => {
  const result = extractContractFromPropertyBag({ semanticCapabilityContract: { foo: 'bar' } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_CONTRACT_MALFORMED');
});

// ============================================================
// Edge preservation across embedding's remove+re-add of the capability
// node. `XoirGraph.removeNode` deletes every edge touching the removed
// node as part of ordinary node deletion — correct for a real delete,
// but embedding isn't a delete, it's a properties replacement under the
// same node id, so the REQUIRES/escalates_to/etc. edges that existed
// before embedding must exist, unchanged, after it.
// ============================================================

test('embedContractInCapabilityNode preserves an edge touching the capability node (REQUIRES, decision -> capability)', () => {
  const graph = buildGraph();
  assert.equal(graph.allEdges().length, 1);

  const result = embedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(result.ok, true);

  const edgesAfter = graph.allEdges();
  assert.equal(edgesAfter.length, 1);
  const edge = edgesAfter.find((e) => e.id === 'e1');
  assert.ok(edge, 'edge "e1" must still exist after embedding');
  assert.equal(edge?.kind, 'REQUIRES');
  assert.equal(edge?.fromId, 'decision:deny-large-claim');
  assert.equal(edge?.toId, 'capability:claim-evaluation');
});

test('embedContractInCapabilityNode preserves multiple edges in both directions (incoming and outgoing)', () => {
  const graph = buildGraph();
  graph.createAndAddNode({ id: XoirNodeId('safety:review-required'), kind: 'safety_policy', properties: { statement: 'flag for manual review', enforcementLevel: 'block' } });
  // An outgoing edge FROM the capability node this time, not just incoming.
  const addResult = graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'ESCALATES_TO', fromId: XoirNodeId('capability:claim-evaluation'), toId: XoirNodeId('safety:review-required') });
  assert.equal(addResult.ok, true);
  assert.equal(graph.allEdges().length, 2);

  const result = embedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(result.ok, true);

  const edgesAfter = graph.allEdges();
  assert.equal(edgesAfter.length, 2, 'both the incoming REQUIRES edge and the outgoing escalates_to edge must survive');
  assert.ok(edgesAfter.some((e) => e.id === 'e1'));
  assert.ok(edgesAfter.some((e) => e.id === 'e2' && e.fromId === 'capability:claim-evaluation' && e.toId === 'safety:review-required'), 'the ESCALATES_TO edge must survive too');
});

test('embedContractInCapabilityNode does not affect edges between two OTHER, unrelated nodes', () => {
  const graph = buildGraph();
  graph.createAndAddNode({ id: XoirNodeId('concept:unrelated'), kind: 'concept', properties: { definition: 'something else entirely' } });
  graph.createAndAddNode({ id: XoirNodeId('fact:unrelated'), kind: 'fact', properties: { statement: 'an unrelated fact' } });
  graph.createAndAddEdge({ id: XoirEdgeId('e-unrelated'), kind: 'SUPPORTS', fromId: XoirNodeId('fact:unrelated'), toId: XoirNodeId('concept:unrelated') });

  const result = embedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(result.ok, true);

  const unrelatedEdge = graph.allEdges().find((e) => e.id === 'e-unrelated');
  assert.ok(unrelatedEdge, 'an edge with no connection to the embedded node must be completely untouched');
});

// ============================================================
// embedResolvedContractInCapabilityNode — the production-packaging
// entry point, given an ALREADY-built contract (no internal
// buildSemanticCapabilityContract re-resolution).
// ============================================================

test('embedResolvedContractInCapabilityNode embeds the exact contract object passed in, without re-resolving', () => {
  const graph = buildGraph();
  const contractResult = buildSemanticCapabilityContract(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(contractResult.ok, true);
  if (!contractResult.ok) return;

  const result = embedResolvedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'), contractResult.value);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const props = result.value.properties as { readonly semanticCapabilityContract?: { readonly id: string } };
  assert.equal(props.semanticCapabilityContract?.id, contractResult.value.id);
});

test('embedResolvedContractInCapabilityNode also preserves touching edges (same guarantee as embedContractInCapabilityNode)', () => {
  const graph = buildGraph();
  const contractResult = buildSemanticCapabilityContract(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(contractResult.ok, true);
  if (!contractResult.ok) return;

  assert.equal(graph.allEdges().length, 1);
  const result = embedResolvedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'), contractResult.value);
  assert.equal(result.ok, true);
  assert.equal(graph.allEdges().length, 1);
  assert.ok(graph.allEdges().some((e) => e.id === 'e1'));
});

// ============================================================
// Version/createdAt preservation across the remove+re-add that both entry
// points perform via the shared replaceCapabilityNodeProperties helper.
// `createNode` (@xo/xoir) defaults `version` to 1 and `createdAt`/
// `updatedAt` to "now" when not passed explicitly — without those fields
// threaded through, re-embedding a contract would silently reset a node's
// version and creation timestamp, even though only its `properties`
// legitimately changed.
// ============================================================

test('embedContractInCapabilityNode preserves the node version and original createdAt timestamp rather than resetting them', () => {
  const graph = buildGraph();
  const originalNode = graph.getNode(XoirNodeId('capability:claim-evaluation'));
  assert.equal(originalNode.ok, true);
  if (!originalNode.ok) return;

  const result = embedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.version, originalNode.value.version);
  assert.equal(result.value.metadata.createdAt, originalNode.value.metadata.createdAt);
});

test('embedResolvedContractInCapabilityNode preserves the node version and original createdAt timestamp rather than resetting them (same shared helper, same guarantee)', () => {
  const graph = buildGraph();
  const originalNode = graph.getNode(XoirNodeId('capability:claim-evaluation'));
  assert.equal(originalNode.ok, true);
  if (!originalNode.ok) return;

  const contractResult = buildSemanticCapabilityContract(graph, XoirNodeId('capability:claim-evaluation'));
  assert.equal(contractResult.ok, true);
  if (!contractResult.ok) return;

  const result = embedResolvedContractInCapabilityNode(graph, XoirNodeId('capability:claim-evaluation'), contractResult.value);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.version, originalNode.value.version);
  assert.equal(result.value.metadata.createdAt, originalNode.value.metadata.createdAt);
});
