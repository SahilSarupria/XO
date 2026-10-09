import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { buildSemanticCapabilityContract } from '../src/contract-builder.js';

test('A. Explicit declared output → authoritative contract output with derivedFrom: declared', () => {
  const graph = XoirGraph.create(XoirGraphId('g-explicit-out'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:calc-brokerage'),
    kind: 'capability',
    properties: {
      name: 'Calculate Brokerage',
      description: 'Calculates the expected brokerage amount',
      outputs: ['calculated_amount: The calculated brokerage amount', 'fee_total'],
    },
  });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:calc-brokerage'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.outputs.length, 2);
  assert.equal(result.value.outputs[0]!.name, 'calculated_amount');
  assert.equal(result.value.outputs[0]!.description, 'The calculated brokerage amount');
  assert.equal(result.value.outputs[0]!.derivedFrom, 'declared');

  assert.equal(result.value.outputs[1]!.name, 'fee_total');
  assert.equal(result.value.outputs[1]!.description, '');
  assert.equal(result.value.outputs[1]!.derivedFrom, 'declared');
});

test('B. Explicit output metadata preserved (derivedFrom: declared)', () => {
  const graph = XoirGraph.create(XoirGraphId('g-metadata-preserved'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:gen-invoice'),
    kind: 'capability',
    properties: {
      name: 'Generate Invoice',
      description: 'Generates an invoice payload',
      outputs: ['invoice_id'],
    },
  });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:gen-invoice'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.outputs.length, 1);
  assert.equal(result.value.outputs[0]!.derivedFrom, 'declared');
});

test('C. Rule outcome rejection: outcome="verified" / "deny the claim" does not become a contract output', () => {
  const graph = XoirGraph.create(XoirGraphId('g-outcome-rejection'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:verify-brokerage'),
    kind: 'capability',
    properties: {
      name: 'Verify Expected Brokerage',
      description: 'Verifies calculated vs expected brokerage',
    },
  });
  graph.createAndAddNode({
    id: XoirNodeId('decision:brokerage-check'),
    kind: 'decision_node',
    properties: {
      question: 'expected_brokerage == calculated_amount',
      outcome: 'verified',
      structuredCondition: {
        type: 'categorical',
        field: 'expected_brokerage',
        operator: '==',
        value: 'calculated_amount',
      },
      structuredAction: {
        type: 'action',
        action: 'deny',
        target: 'the claim',
      },
    },
  });
  graph.createAndAddEdge({
    id: XoirEdgeId('e1'),
    kind: 'REQUIRES',
    fromId: XoirNodeId('decision:brokerage-check'),
    toId: XoirNodeId('capability:verify-brokerage'),
  });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:verify-brokerage'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Outcome 'verified' must NOT become a contract output
  assert.deepEqual(result.value.outputs, []);
});

test('D. Comparison operand rejection: structuredCondition fields/values do not become contract outputs', () => {
  const graph = XoirGraph.create(XoirGraphId('g-operand-rejection'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:check-limit'),
    kind: 'capability',
    properties: {
      name: 'Check Claim Limit',
      description: 'Checks loss against threshold',
    },
  });
  graph.createAndAddNode({
    id: XoirNodeId('constraint:loss-limit'),
    kind: 'constraint',
    properties: {
      rule: 'loss_amount <= 10000',
      structuredCondition: {
        type: 'comparison',
        field: 'loss_amount',
        operator: '<=',
        value: 10000,
      },
    },
  });
  graph.createAndAddEdge({
    id: XoirEdgeId('e1'),
    kind: 'REQUIRES',
    fromId: XoirNodeId('constraint:loss-limit'),
    toId: XoirNodeId('capability:check-limit'),
  });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:check-limit'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Rule fields are promoted to inputs (rule_derived), NOT outputs!
  assert.equal(result.value.inputs.length, 1);
  assert.equal(result.value.inputs[0]!.name, 'loss_amount');
  assert.equal(result.value.inputs[0]!.derivedFrom, 'rule_derived');
  assert.deepEqual(result.value.outputs, []);
});

test('E. Capability name/description rejection: name alone does not create contract outputs', () => {
  const graph = XoirGraph.create(XoirGraphId('g-name-rejection'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:reconcile'),
    kind: 'capability',
    properties: {
      name: 'Reconcile Records and Produce Reconciliation Report',
      description: 'System automatically generates a reconciliation statement and output report',
    },
  });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:reconcile'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.outputs, []);
});

test('F. Sequence edge rejection: custom:sequence edge does not create contract outputs', () => {
  const graph = XoirGraph.create(XoirGraphId('g-seq-rejection'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:step1'),
    kind: 'capability',
    properties: { name: 'Step 1', description: 'First step' },
  });
  graph.createAndAddNode({
    id: XoirNodeId('capability:step2'),
    kind: 'capability',
    properties: { name: 'Step 2', description: 'Second step' },
  });
  graph.createAndAddEdge({
    id: XoirEdgeId('e-seq'),
    kind: 'custom:sequence',
    fromId: XoirNodeId('capability:step1'),
    toId: XoirNodeId('capability:step2'),
  });

  const result1 = buildSemanticCapabilityContract(graph, XoirNodeId('capability:step1'));
  assert.equal(result1.ok, true);
  if (!result1.ok) return;
  assert.deepEqual(result1.value.outputs, []);

  const result2 = buildSemanticCapabilityContract(graph, XoirNodeId('capability:step2'));
  assert.equal(result2.ok, true);
  if (!result2.ok) return;
  assert.deepEqual(result2.value.outputs, []);
});

test('G. PRODUCES concept edge handling: PRODUCES edge to Concept node does not create a typed parameter output', () => {
  const graph = XoirGraph.create(XoirGraphId('g-produces-rejection'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:obtain-stmt'),
    kind: 'capability',
    properties: { name: 'Obtain Insurer Statement', description: 'Obtains statement document' },
  });
  graph.createAndAddNode({
    id: XoirNodeId('concept:insurer-stmt'),
    kind: 'concept',
    properties: { definition: 'Insurer Statement Document' },
  });
  graph.createAndAddEdge({
    id: XoirEdgeId('e-produces'),
    kind: 'PRODUCES',
    fromId: XoirNodeId('capability:obtain-stmt'),
    toId: XoirNodeId('concept:insurer-stmt'),
  });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:obtain-stmt'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.outputs, []);
});

test('H. StructuredAction handling: StructuredAction target from rule nodes is NOT promoted to contract output', () => {
  const graph = XoirGraph.create(XoirGraphId('g-action-target-rejection'));
  graph.createAndAddNode({
    id: XoirNodeId('capability:eval-claim'),
    kind: 'capability',
    properties: { name: 'Evaluate Claim', description: 'Evaluates claim validity' },
  });
  graph.createAndAddNode({
    id: XoirNodeId('decision:rule1'),
    kind: 'decision_node',
    properties: {
      question: 'claim_amount > 5000',
      outcome: 'escalate to supervisor',
      structuredAction: {
        type: 'action',
        action: 'escalate',
        target: 'to supervisor',
      },
    },
  });
  graph.createAndAddEdge({
    id: XoirEdgeId('e1'),
    kind: 'REQUIRES',
    fromId: XoirNodeId('decision:rule1'),
    toId: XoirNodeId('capability:eval-claim'),
  });

  const result = buildSemanticCapabilityContract(graph, XoirNodeId('capability:eval-claim'));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.outputs, []);
});
