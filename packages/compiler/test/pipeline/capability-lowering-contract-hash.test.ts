import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { computeContractContentHash, extractContractFromPropertyBag, buildSemanticCapabilityContract } from '@xo/capability-contract';
import { lowerCapabilitiesToManifest } from '../../src/pipeline/capability-lowering.js';

/**
 * P0.9B Step 3 — the contract content hash at the lowering/embedding
 * point: the manifest declaration and the packaged knowledge-graph node
 * must carry the same hash, it must survive the JSON round trip a real
 * package goes through, and it must be stable across equivalent
 * compilations.
 */

const now = () => '2026-01-01T00:00:00.000Z';

/** Mirrors packager.test.ts's `addResolvableCapability` fixture: a capability + one linked `decision_node` whose condition parses under `StructuredComparisonBindingResolver`'s closed grammar — resolves to `'resolved'`, `implementationClass: 'deterministic_rule'`. */
function graphWithResolvableCapability(suffix = 'a'): { readonly graph: XoirGraph; readonly capabilityId: string; readonly decisionId: string } {
  const graph = XoirGraph.create(XoirGraphId(`g-${suffix}`));
  const capabilityId = `capability:evaluate-claim-${suffix}`;
  const decisionId = `decision:deny-large-claim-${suffix}`;
  graph.createAndAddNode({
    id: XoirNodeId(capabilityId),
    kind: 'capability',
    properties: { name: 'Evaluate Claim', description: 'Evaluates a submitted claim against policy rules.', determinism: 'deterministic' },
    confidence: 0.7,
    now,
  });
  graph.createAndAddNode({
    id: XoirNodeId(decisionId),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' },
    confidence: 0.9,
    now,
  });
  graph.createAndAddEdge({ id: XoirEdgeId(`req-${suffix}`), kind: 'REQUIRES', fromId: XoirNodeId(decisionId), toId: XoirNodeId(capabilityId), now });
  return { graph, capabilityId, decisionId };
}


test('the lowered declaration carries contractContentHash == the hash of the contract it was lowered from', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('h1');
  const contract = buildSemanticCapabilityContract(graph, XoirNodeId(capabilityId));
  assert.ok(contract.ok);
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;
  assert.equal(declaration.execution!.contractContentHash, computeContractContentHash(contract.value));
});

test('the embedded contract carries the same hash, and it still verifies after a JSON round trip (what an installed package sees)', () => {
  const { graph, capabilityId } = graphWithResolvableCapability('h2');
  const result = lowerCapabilitiesToManifest(graph);
  const declaration = result.declarations.find((d) => d.id === capabilityId)!;

  const node = graph.getNode(XoirNodeId(capabilityId));
  assert.ok(node.ok);
  const roundTripped = JSON.parse(JSON.stringify(node.value.properties)) as Record<string, unknown>;
  const extracted = extractContractFromPropertyBag(roundTripped);
  assert.ok(extracted.ok);
  assert.equal(extracted.value.contentHash, declaration.execution!.contractContentHash);
  assert.equal(computeContractContentHash(extracted.value), declaration.execution!.contractContentHash);
});

test('equivalent compilations (different graph/capability ids, same semantic content) produce the same content hash', () => {
  const a = lowerCapabilitiesToManifest(graphWithResolvableCapability('eqA').graph).declarations[0]!;
  const b = lowerCapabilitiesToManifest(graphWithResolvableCapability('eqB').graph).declarations[0]!;
  assert.notEqual(a.id, b.id);
  assert.equal(a.execution!.contractContentHash, b.execution!.contractContentHash);
});

test('lowering the same graph twice yields the same content hash (deterministic)', () => {
  const first = lowerCapabilitiesToManifest(graphWithResolvableCapability('det').graph).declarations[0]!;
  const second = lowerCapabilitiesToManifest(graphWithResolvableCapability('det').graph).declarations[0]!;
  assert.equal(first.execution!.contractContentHash, second.execution!.contractContentHash);
});

test('a semantic change to the source rule changes the lowered content hash', () => {
  const { graph } = graphWithResolvableCapability('chg1');
  const changed = graphWithResolvableCapability('chg2');
  const decision = changed.graph.getNode(XoirNodeId(changed.decisionId));
  assert.ok(decision.ok);
  changed.graph.removeNode(XoirNodeId(changed.decisionId));
  changed.graph.createAndAddNode({ id: XoirNodeId(changed.decisionId), kind: 'decision_node', properties: { question: 'the claimed loss amount exceeds 25000', outcome: 'deny the claim' }, confidence: 0.9, now });
  changed.graph.createAndAddEdge({ id: XoirEdgeId('req-chg2b'), kind: 'REQUIRES', fromId: XoirNodeId(changed.decisionId), toId: XoirNodeId(changed.capabilityId), now });
  const a = lowerCapabilitiesToManifest(graph).declarations[0]!;
  const b = lowerCapabilitiesToManifest(changed.graph).declarations[0]!;
  assert.notEqual(a.execution!.contractContentHash, b.execution!.contractContentHash);
});
