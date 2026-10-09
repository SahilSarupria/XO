import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { composeWorkflows } from '../src/compose.js';
import { auditWorkflowDataFlow } from '../src/data-flow-audit.js';

let counter = 0;
function uniqueId(prefix: string) {
  return `${prefix}-${++counter}`;
}

describe('Phase 4.1 — Workflow Data-Flow Evidence Audit', () => {
  it('Test A — Proven binding: explicit output + input + name match + type compatibility + structural corroboration', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A', outputs: ['invoice_balance: Invoice balance amount'] },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B', inputs: ['invoice_balance: Invoice balance amount'] },
    });
    // Direct graph edge for structural corroboration + precedence
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: capA });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;
    const workflow = wfRes.value[0]!;

    const report = auditWorkflowDataFlow(workflow, graph);
    assert.equal(report.bindings.length, 1);
    const binding = report.bindings[0]!;
    assert.equal(binding.status, 'proven');
    assert.equal(binding.evidenceKind, 'explicit_contract_match');
    assert.equal(binding.outputParameterName, 'invoice_balance');
    assert.equal(binding.inputParameterName, 'invoice_balance');
  });

  it('Test B — Name match without structure: suggestive (name_similarity_only)', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A', outputs: ['invoice_balance: Balance'] },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B', inputs: ['invoice_balance: Balance'] },
    });

    const workflow = {
      id: 'wf_test' as any,
      name: 'Test Workflow',
      steps: [
        { id: 's1' as any, order: 0, capabilityId: 'cap_a', capabilityName: 'Cap A', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
        { id: 's2' as any, order: 1, capabilityId: 'cap_b', capabilityName: 'Cap B', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
      ],
      gaps: [],
      processGrouping: { sectionPath: ['s'] },
    };

    const report = auditWorkflowDataFlow(workflow, graph);
    assert.equal(report.bindings.length, 1);
    assert.equal(report.bindings[0]?.status, 'suggestive');
    assert.equal(report.bindings[0]?.evidenceKind, 'name_similarity_only');
    assert.equal(report.unboundInputs.length, 1);
  });

  it('Test C — Type equality alone produces no proven binding', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');
    const ruleB = XoirNodeId('rule_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A', outputs: ['amount: Amount'] },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B' },
    });
    graph.createAndAddNode({
      id: ruleB,
      kind: 'decision_node',
      properties: {
        question: 'threshold',
        outcome: 'ok',
        structuredCondition: { type: 'comparison', field: 'fee_limit', operator: '>', value: 100 },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: capA });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: ruleB });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;

    const report = auditWorkflowDataFlow(wfRes.value[0]!, graph);
    // fee_limit (number) vs amount (number) have different names -> no proven binding
    const proven = report.bindings.filter((b) => b.status === 'proven');
    assert.equal(proven.length, 0);
    assert.equal(report.unboundInputs.length, 1);
    assert.equal(report.unboundInputs[0]?.parameterName, 'fee_limit');
  });

  it('Test D — Concept PRODUCES/CONSUMES creates suggestive binding (concept_produces_consumes)', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');
    const conceptC = XoirNodeId('concept_c');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A' },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B', inputs: ['statement_file: File'] },
    });
    graph.createAndAddNode({
      id: conceptC,
      kind: 'concept',
      properties: { definition: 'Statement Concept' },
    });

    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'PRODUCES', fromId: capA, toId: conceptC });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'CONSUMES', fromId: capB, toId: conceptC });

    const workflow = {
      id: 'wf_test' as any,
      name: 'Test Workflow',
      steps: [
        { id: 's1' as any, order: 0, capabilityId: 'cap_a', capabilityName: 'Cap A', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
        { id: 's2' as any, order: 1, capabilityId: 'cap_b', capabilityName: 'Cap B', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
      ],
      gaps: [],
      processGrouping: { sectionPath: ['s'] },
    };

    const report = auditWorkflowDataFlow(workflow, graph);
    assert.equal(report.bindings.length, 1);
    assert.equal(report.bindings[0]?.status, 'suggestive');
    assert.equal(report.bindings[0]?.evidenceKind, 'concept_produces_consumes');
  });

  it('Test E — REQUIRES alone does not create a field binding', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A' },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B', inputs: ['param_x: Param X'] },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: capA });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;

    const report = auditWorkflowDataFlow(wfRes.value[0]!, graph);
    assert.equal(report.bindings.length, 0);
    assert.equal(report.unboundInputs.length, 1);
    assert.equal(report.unboundInputs[0]?.parameterName, 'param_x');
  });

  it('Test F — Sequence (custom:sequence) alone does not create field binding', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A' },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B', inputs: ['param_y: Param Y'] },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'custom:sequence' as any, fromId: capA, toId: capB });

    const workflow = {
      id: 'wf_seq' as any,
      name: 'Seq Workflow',
      steps: [
        { id: 's1' as any, order: 0, capabilityId: 'cap_a', capabilityName: 'Cap A', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
        { id: 's2' as any, order: 1, capabilityId: 'cap_b', capabilityName: 'Cap B', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
      ],
      gaps: [],
      processGrouping: { sectionPath: ['s'] },
    };

    const report = auditWorkflowDataFlow(workflow, graph);
    assert.equal(report.bindings.length, 0);
    assert.equal(report.unboundInputs.length, 1);
  });

  it('Test G — Process membership (sectionPath) alone does not create field binding', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A' },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B', inputs: ['param_z: Param Z'] },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'COMPLEMENTS', fromId: capB, toId: capA });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;

    const report = auditWorkflowDataFlow(wfRes.value[0]!, graph);
    assert.equal(report.bindings.length, 0);
    assert.equal(report.unboundInputs.length, 1);
  });

  it('Test H — Primitive type conflict prevents proven binding', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');
    const ruleB = XoirNodeId('rule_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: {
        name: 'Cap A',
        description: 'Cap A',
        semanticCapabilityContract: {
          id: 'cap_a',
          name: 'Cap A',
          description: 'Cap A',
          inputs: [],
          outputs: [{ name: 'status', description: 'Status string', semanticType: 'string', derivedFrom: 'declared' }],
          requiredPermissions: [],
          determinism: 'deterministic',
          rules: [],
          actionKnowledgeRefs: [],
          confidence: 1,
          sourceRefs: [],
          sourceXoirNodeIds: ['cap_a'],
        },
      },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B' },
    });
    graph.createAndAddNode({
      id: ruleB,
      kind: 'decision_node',
      properties: {
        question: 'status exceeds 10',
        outcome: 'ok',
        structuredCondition: { type: 'comparison', field: 'status', operator: '>', value: 10 },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: capA });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: ruleB });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;

    const report = auditWorkflowDataFlow(wfRes.value[0]!, graph);
    // Output 'status' is string ('status: Status string'), input 'status' is number (from comparison value: 10). Type conflict -> not proven.
    const proven = report.bindings.filter((b) => b.status === 'proven');
    assert.equal(proven.length, 0);
    assert.equal(report.unboundInputs.length, 1);
  });

  it('Test I — Rule-derived input participates as consumer input without required: true', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');
    const ruleB = XoirNodeId('rule_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A', outputs: ['expected_brokerage: Amount'] },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B' },
    });
    graph.createAndAddNode({
      id: ruleB,
      kind: 'decision_node',
      properties: {
        question: 'expected_brokerage > 0',
        outcome: 'ok',
        structuredCondition: { type: 'comparison', field: 'expected_brokerage', operator: '>', value: 0 },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: capA });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: ruleB });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;

    const report = auditWorkflowDataFlow(wfRes.value[0]!, graph);
    assert.equal(report.bindings.length, 1);
    assert.equal(report.bindings[0]?.status, 'proven');
    assert.equal(report.bindings[0]?.inputParameterName, 'expected_brokerage');
  });

  it('Test J — Unbound input reported when no preceding producer exists', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A', inputs: ['missing_param: Missing'] },
    });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;

    const report = auditWorkflowDataFlow(wfRes.value[0]!, graph);
    assert.equal(report.bindings.length, 0);
    assert.equal(report.unboundInputs.length, 1);
    assert.equal(report.unboundInputs[0]?.parameterName, 'missing_param');
    assert.equal(report.unboundInputs[0]?.derivedFrom, 'declared');
  });

  it('Test K — Later producer step cannot satisfy earlier consumer step', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));

    const workflow = {
      id: 'wf_test' as any,
      name: 'Test Workflow',
      steps: [
        // Step 1: Consumer comes FIRST
        { id: 's1' as any, order: 0, capabilityId: 'cap_consumer', capabilityName: 'Consumer', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
        // Step 2: Producer comes LATER
        { id: 's2' as any, order: 1, capabilityId: 'cap_producer', capabilityName: 'Producer', description: '', rationale: { orderedAfter: [], tieBroken: false }, confidence: 1, evidence: [] },
      ],
      gaps: [],
      processGrouping: { sectionPath: ['s'] },
    };

    graph.createAndAddNode({
      id: XoirNodeId('cap_consumer'),
      kind: 'capability',
      properties: { name: 'Consumer', description: 'Consumer', inputs: ['data_key: Key'] },
    });
    graph.createAndAddNode({
      id: XoirNodeId('cap_producer'),
      kind: 'capability',
      properties: { name: 'Producer', description: 'Producer', outputs: ['data_key: Key'] },
    });

    const report = auditWorkflowDataFlow(workflow, graph);
    assert.equal(report.bindings.length, 0);
    assert.equal(report.unboundInputs.length, 1);
    assert.equal(report.unboundInputs[0]?.parameterName, 'data_key');
  });

  it('Test L — Determinism across repeated calls', () => {
    const graph = XoirGraph.create(XoirGraphId(uniqueId('g')));
    const capA = XoirNodeId('cap_a');
    const capB = XoirNodeId('cap_b');

    graph.createAndAddNode({
      id: capA,
      kind: 'capability',
      properties: { name: 'Cap A', description: 'Cap A', outputs: ['var_1: Var 1'] },
    });
    graph.createAndAddNode({
      id: capB,
      kind: 'capability',
      properties: { name: 'Cap B', description: 'Cap B', inputs: ['var_1: Var 1', 'var_2: Var 2'] },
    });
    graph.createAndAddEdge({ id: XoirEdgeId(uniqueId('e')), kind: 'REQUIRES', fromId: capB, toId: capA });

    const wfRes = composeWorkflows(graph);
    assert.equal(wfRes.ok, true);
    if (!wfRes.ok) return;

    const report1 = auditWorkflowDataFlow(wfRes.value[0]!, graph);
    const report2 = auditWorkflowDataFlow(wfRes.value[0]!, graph);

    assert.deepEqual(report1, report2);
  });
});
