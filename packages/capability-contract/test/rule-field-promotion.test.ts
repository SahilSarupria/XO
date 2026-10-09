import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { buildSemanticCapabilityContract } from '../src/contract-builder.js';
import { StructuredComparisonBindingResolver } from '../src/structured-comparison-resolver.js';

let counter = 0;
function uniqueId(prefix: string) {
  return `${prefix}-${++counter}`;
}

describe('Phase 3.1 — Rule-Field Promotion & Typed Parameters', () => {
  it('A. promotes structuredCondition.field with derivedFrom: rule_derived', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Calculate Brokerage', description: 'Calculates brokerage' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'Is expected brokerage above 100?',
        outcome: 'valid',
        structuredCondition: {
          type: 'comparison',
          field: 'expected_brokerage',
          operator: '>',
          value: 100,
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const contractRes = buildSemanticCapabilityContract(graph, capId);
    assert.equal(contractRes.ok, true);
    if (!contractRes.ok) return;

    const contract = contractRes.value;
    assert.equal(contract.inputs.length, 1);
    const param = contract.inputs[0]!;
    assert.equal(param.name, 'expected_brokerage');
    assert.equal(param.derivedFrom, 'rule_derived');
    assert.equal(param.description, '');
  });

  it('B. infers semanticType: number for numeric comparisons & ranges', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'heuristic',
      properties: {
        condition: 'amount exceeds 500',
        action: 'flag',
        structuredCondition: {
          type: 'comparison',
          field: 'claim_amount',
          operator: '>',
          value: 500,
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.semanticType, 'number');
  });

  it('C. infers semanticType: string for categorical conditions', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'heuristic',
      properties: {
        condition: 'claim status is approved',
        action: 'process',
        structuredCondition: {
          type: 'categorical',
          field: 'claim_status',
          operator: '==',
          value: 'approved',
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.semanticType, 'string');
  });

  it('D. infers semanticType: boolean for boolean values', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'heuristic',
      properties: {
        condition: 'is_active is true',
        action: 'proceed',
        structuredCondition: {
          type: 'categorical',
          field: 'is_active',
          operator: '==',
          value: 'true',
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.semanticType, 'boolean');
  });

  it('E. sets semanticType: unknown for temporal conditions without primitive value evidence', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'heuristic',
      properties: {
        condition: 'within 30 days of reported loss date',
        action: 'check',
        structuredCondition: {
          type: 'temporal',
          relation: 'within',
          amount: 30,
          unit: 'days',
          field: 'reported loss date',
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.semanticType, 'unknown');
  });

  it('F. leaves required as undefined for rule-derived parameters', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'Check expected_brokerage',
        outcome: 'ok',
        structuredCondition: {
          type: 'comparison',
          field: 'expected_brokerage',
          operator: '>',
          value: 0,
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs[0]?.required, undefined);
  });

  it('G. respects explicit declaration precedence and preserves derivedFrom: declared', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: {
        name: 'Cap',
        description: 'Cap',
        inputs: ['expected_brokerage: Expected brokerage amount'],
      },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'Check expected_brokerage',
        outcome: 'ok',
        structuredCondition: {
          type: 'comparison',
          field: 'expected_brokerage',
          operator: '>',
          value: 0,
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.name, 'expected_brokerage');
    assert.equal(res.value.inputs[0]?.description, 'Expected brokerage amount');
    assert.equal(res.value.inputs[0]?.derivedFrom, 'declared');
  });

  it('H. deduplicates multiple linked rules referencing the same field', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const rule1 = XoirNodeId(uniqueId('rule'));
    const rule2 = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: rule1,
      kind: 'decision_node',
      properties: {
        question: 'Rule 1',
        outcome: 'ok',
        structuredCondition: { type: 'comparison', field: 'expected_brokerage', operator: '>', value: 0 },
      },
    });
    graph.createAndAddNode({
      id: rule2,
      kind: 'heuristic',
      properties: {
        condition: 'Rule 2',
        action: 'ok',
        structuredCondition: { type: 'comparison', field: 'expected_brokerage', operator: '<', value: 1000 },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: rule1, toId: capId });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: rule2, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.name, 'expected_brokerage');
    assert.equal(res.value.inputs[0]?.derivedFrom, 'rule_derived');
  });

  it('I. does not promote RHS or non-field values', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'Check expected_brokerage against calculated_amount',
        outcome: 'ok',
        structuredCondition: { type: 'comparison', field: 'expected_brokerage', operator: '>', value: 100 },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.name, 'expected_brokerage');
    assert.equal(res.value.inputs.find((i) => i.name === 'calculated_amount'), undefined);
  });

  it('J. does not promote rule outcomes to contract outputs', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'Rule',
        outcome: 'verified',
        structuredCondition: { type: 'categorical', field: 'status', operator: '==', value: 'approved' },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.value.outputs.length, 0);
  });

  it('K. does not promote fields existing only inside structured exceptions', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'heuristic',
      properties: {
        condition: 'Check status',
        action: 'approve',
        structuredCondition: { type: 'categorical', field: 'status', operator: '==', value: 'valid' },
        structuredExceptions: [
          {
            raw: 'unless incorrect_information',
            condition: { type: 'categorical', field: 'incorrect_information', operator: '==', value: 'true' },
          },
        ],
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    // Only 'status' is promoted, 'incorrect_information' from exception condition is NOT promoted
    assert.equal(res.value.inputs.length, 1);
    assert.equal(res.value.inputs[0]?.name, 'status');
    assert.equal(res.value.inputs.find((i) => i.name === 'incorrect_information'), undefined);
  });

  it('L. maintains full compatibility with StructuredComparisonBindingResolver', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capId = XoirNodeId(uniqueId('cap'));
    const ruleId = XoirNodeId(uniqueId('rule'));

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Cap', description: 'Cap' },
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'Is claimed_loss_amount above 1000?',
        outcome: 'approved',
        structuredCondition: { type: 'comparison', field: 'claimed_loss_amount', operator: '>', value: 1000 },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: ruleId, toId: capId });

    const res = buildSemanticCapabilityContract(graph, capId);
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const contract = res.value;

    const resolver = new StructuredComparisonBindingResolver();
    const outcome = resolver.resolve(contract);

    assert.equal(outcome?.status, 'resolved');
    if (outcome?.status === 'resolved' && outcome.binding.evaluate) {
      const evalRes = outcome.binding.evaluate({ claimedlossamount: 1500 });
      assert.equal(evalRes.ok, true);
      if (evalRes.ok) {
        assert.equal(evalRes.value.matched, true);
      }
    }
  });
});
