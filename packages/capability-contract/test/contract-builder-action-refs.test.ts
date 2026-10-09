import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { buildSemanticCapabilityContract } from '../src/contract-builder.js';

/**
 * Action Capability Binding v1 — tests for the new, additive
 * `actionKnowledgeRefs` contract-builder projection. Mirrors
 * `contract-builder.test.ts`'s own conventions/fixture style exactly
 * (synthetic graphs, no compiler/PDF dependency) so these tests exercise
 * the exact same code path a real compiled document goes through,
 * without depending on any specific document or domain.
 */

test('a concept node linked via REQUIRES with subtype "action" is captured in actionKnowledgeRefs', () => {
  const graph = XoirGraph.create(XoirGraphId('g-action-1'));
  graph.createAndAddNode({ id: XoirNodeId('capability:reconcile'), kind: 'capability', properties: { name: 'Reconcile the invoice balance', description: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('concept:reconcile-action'), kind: 'concept', properties: { definition: 'Reconcile the invoice balance against payments received' }, subtype: 'action' });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('concept:reconcile-action'), toId: XoirNodeId('capability:reconcile') });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:reconcile'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.rules.length, 0);
  assert.deepEqual(result.value.actionKnowledgeRefs, [{ sourceNodeId: 'concept:reconcile-action', subtype: 'action' }]);
  assert.deepEqual(result.value.sourceXoirNodeIds, ['capability:reconcile', 'concept:reconcile-action']);
});

test('a concept node linked via an OUTGOING REQUIRES edge (capability -> concept) with subtype "process" is also captured', () => {
  const graph = XoirGraph.create(XoirGraphId('g-process-1'));
  graph.createAndAddNode({ id: XoirNodeId('capability:onboard-vendor'), kind: 'capability', properties: { name: 'Onboard Vendor', description: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('concept:onboarding-process'), kind: 'concept', properties: { definition: 'The vendor onboarding process consists of KYC, contract signing, and system provisioning' }, subtype: 'process' });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('capability:onboard-vendor'), toId: XoirNodeId('concept:onboarding-process') });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:onboard-vendor'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.actionKnowledgeRefs, [{ sourceNodeId: 'concept:onboarding-process', subtype: 'process' }]);
});

test('a linked concept node with no subtype, or a subtype other than action/process, is NOT captured', () => {
  const graph = XoirGraph.create(XoirGraphId('g-non-action-1'));
  graph.createAndAddNode({ id: XoirNodeId('capability:file-claim'), kind: 'capability', properties: { name: 'File Claim', description: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('concept:policyholder'), kind: 'concept', properties: { definition: 'Policyholder' } }); // no subtype at all
  graph.createAndAddNode({ id: XoirNodeId('concept:organization'), kind: 'concept', properties: { definition: 'Acme Corp' }, subtype: 'organization' }); // unrelated subtype
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('capability:file-claim'), toId: XoirNodeId('concept:policyholder') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'REQUIRES', fromId: XoirNodeId('capability:file-claim'), toId: XoirNodeId('concept:organization') });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:file-claim'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.actionKnowledgeRefs, []);
});

test('a capability with no linked nodes at all gets an empty actionKnowledgeRefs, not an error', () => {
  const graph = XoirGraph.create(XoirGraphId('g-bare'));
  graph.createAndAddNode({ id: XoirNodeId('capability:bare'), kind: 'capability', properties: { name: 'Bare', description: 'No linked anything' } });
  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:bare'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.actionKnowledgeRefs, []);
  assert.deepEqual(result.value.rules, []);
});

test('a capability with BOTH a linked rule and a linked action-knowledge node populates both fields independently', () => {
  const graph = XoirGraph.create(XoirGraphId('g-both'));
  graph.createAndAddNode({ id: XoirNodeId('capability:evaluate-claim'), kind: 'capability', properties: { name: 'Evaluate Claim', description: 'd', determinism: 'deterministic' } });
  graph.createAndAddNode({ id: XoirNodeId('decision:deny-large-claim'), kind: 'decision_node', properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim', rationale: 'r' } });
  graph.createAndAddNode({ id: XoirNodeId('concept:file-claim-action'), kind: 'concept', properties: { definition: 'File the claim with the adjuster' }, subtype: 'action' });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('decision:deny-large-claim'), toId: XoirNodeId('capability:evaluate-claim') });
  graph.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'REQUIRES', fromId: XoirNodeId('capability:evaluate-claim'), toId: XoirNodeId('concept:file-claim-action') });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:evaluate-claim'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.rules.length, 1);
  assert.deepEqual(result.value.actionKnowledgeRefs, [{ sourceNodeId: 'concept:file-claim-action', subtype: 'action' }]);
  assert.deepEqual(result.value.sourceXoirNodeIds, ['capability:evaluate-claim', 'concept:file-claim-action', 'decision:deny-large-claim']);
});

test('deterministic: building twice from the same graph produces deep-equal actionKnowledgeRefs', () => {
  const graph = XoirGraph.create(XoirGraphId('g-det'));
  graph.createAndAddNode({ id: XoirNodeId('capability:reconcile'), kind: 'capability', properties: { name: 'Reconcile', description: 'd' } });
  graph.createAndAddNode({ id: XoirNodeId('concept:reconcile-action'), kind: 'concept', properties: { definition: 'd' }, subtype: 'action' });
  graph.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('concept:reconcile-action'), toId: XoirNodeId('capability:reconcile') });

  const first = buildSemanticCapabilityContract(graph, XoirNodeId('capability:reconcile'));
  const second = buildSemanticCapabilityContract(graph, XoirNodeId('capability:reconcile'));
  assert.deepEqual(first, second);
});
