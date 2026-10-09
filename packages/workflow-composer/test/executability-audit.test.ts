import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import type { CapabilityExecutionDeclaration } from '@xo/types';
import { composeWorkflows } from '../src/compose.js';
import { auditWorkflowExecutability } from '../src/audit.js';
import { buildReconciliationSectionFixtureGraph } from './fixtures/reconciliation-fixture.js';

test('Workflow Executability & Strategy Evidence Audit', async (t) => {
  await t.test('1. deterministic capability -> deterministic evidence', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-deterministic-graph'));
    const capId = XoirNodeId('cap_calc_tax');
    const ruleId = XoirNodeId('rule_tax_decision');

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Calculate Tax', description: 'Calculates GST/TDS tax' },
    });

    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'amount > 1000',
        outcome: 'apply_tax',
        structuredCondition: {
          type: 'comparison',
          field: 'amount',
          operator: '>',
          value: 1000,
        },
      },
    });

    graph.createAndAddEdge({
      id: XoirEdgeId('e_req1'),
      kind: 'REQUIRES',
      fromId: capId,
      toId: ruleId,
    });

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.equal(report.steps.length, 1);
    const step = report.steps[0]!;
    assert.equal(step.strategyEvidence.category, 'deterministic');
    assert.equal(step.strategyEvidence.hasDeterministicEvidence, true);
    assert.equal(step.authority, 'proven');
    assert.ok(step.bindingId?.includes('structured-comparison-resolver'));
  });

  await t.test('2. HITL action capability -> HITL evidence', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-hitl-graph'));
    const capId = XoirNodeId('cap_reconcile_invoice');
    const actionId = XoirNodeId('kn_reconcile_action');

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Reconcile Invoice', description: 'Manual invoice reconciliation' },
    });

    graph.createAndAddNode({
      id: actionId,
      kind: 'concept',
      properties: { definition: 'Reconcile invoice with bank statement' },
      subtype: 'action',
    });

    graph.createAndAddEdge({
      id: XoirEdgeId('e_req2'),
      kind: 'REQUIRES',
      fromId: capId,
      toId: actionId,
    });

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.equal(report.steps.length, 1);
    const step = report.steps[0]!;
    assert.equal(step.strategyEvidence.category, 'hitl');
    assert.equal(step.strategyEvidence.hasHitlEvidence, true);
    assert.equal(step.authority, 'proven');
    assert.ok(step.bindingId?.includes('action-escalation-resolver'));
  });

  await t.test('3. model mode explicitly declared -> model eligibility', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-model-graph'));
    const capId = XoirNodeId('cap_assess_risk');

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Assess Property Risk', description: 'Free-text risk description assessment' },
    });

    const decls = new Map<string, CapabilityExecutionDeclaration>([
      [
        'cap_assess_risk',
        {
          mode: 'model',
        },
      ],
    ]);

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph, { capabilityExecutionDeclarations: decls });

    assert.equal(report.steps.length, 1);
    const step = report.steps[0]!;
    assert.equal(step.strategyEvidence.category, 'model');
    assert.equal(step.strategyEvidence.hasModelEligibility, true);
    assert.equal(step.authority, 'eligible');
  });

  await t.test('4. hybrid mode explicitly declared -> hybrid evidence', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-hybrid-graph'));
    const capId = XoirNodeId('cap_hybrid_eval');

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Hybrid Evaluation', description: 'Rule validation followed by model analysis' },
    });

    const decls = new Map<string, CapabilityExecutionDeclaration>([
      [
        'cap_hybrid_eval',
        {
          mode: 'hybrid',
          hybridSteps: [
            { stepId: 'step1', strategy: 'deterministic_rule', input: { kind: 'request' } },
            { stepId: 'step2', strategy: 'model', input: { kind: 'step', stepId: 'step1' } },
          ],
        },
      ],
    ]);

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph, { capabilityExecutionDeclarations: decls });

    assert.equal(report.steps.length, 1);
    const step = report.steps[0]!;
    assert.equal(step.strategyEvidence.category, 'hybrid');
    assert.equal(step.strategyEvidence.hasHybridEligibility, true);
    assert.equal(step.authority, 'eligible');
  });

  await t.test('5. missing contract -> insufficient', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-missing-contract-graph'));
    const capId = XoirNodeId('cap_bare');

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Bare Capability', description: 'No rules, no action refs' },
    });

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.equal(report.steps.length, 1);
    const step = report.steps[0]!;
    assert.equal(step.strategyEvidence.category, 'insufficient');
    assert.equal(step.authority, 'insufficient');
    assert.ok(step.blockers.some((b) => b.kind === 'unresolved_strategy'));
  });

  await t.test('6. unresolved binding -> blocker', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-unresolved-binding-graph'));
    const capId = XoirNodeId('cap_unparseable_rule');
    const ruleId = XoirNodeId('rule_unparseable');

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Complex Rule Capability' },
    });

    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'Arbitrary unparseable natural language question with complex semantics',
      },
    });

    graph.createAndAddEdge({
      id: XoirEdgeId('e_req3'),
      kind: 'REQUIRES',
      fromId: capId,
      toId: ruleId,
    });

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.equal(report.steps[0]!.strategyEvidence.category, 'insufficient');
    assert.equal(report.steps[0]!.authority, 'insufficient');
    assert.ok(report.blockers.some((b) => b.kind === 'unresolved_strategy'));
  });

  await t.test('7. unparseable exception condition -> blocker', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-exception-graph'));
    const capId = XoirNodeId('cap_heuristic_exception');
    const ruleId = XoirNodeId('rule_heuristic');

    graph.createAndAddNode({
      id: capId,
      kind: 'capability',
      properties: { name: 'Heuristic Capability' },
    });

    graph.createAndAddNode({
      id: ruleId,
      kind: 'heuristic',
      properties: {
        condition: 'amount > 500',
        action: 'flag_review',
        exceptionConditions: ['unless client is VIP tier 1'],
        structuredCondition: {
          kind: 'numeric_comparison',
          left: { kind: 'field_path', path: ['amount'] },
          operator: 'gt',
          right: { kind: 'numeric_literal', value: 500 },
        },
      },
    });

    graph.createAndAddEdge({
      id: XoirEdgeId('e_req4'),
      kind: 'REQUIRES',
      fromId: capId,
      toId: ruleId,
    });

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    const step = report.steps[0]!;
    assert.equal(step.authority, 'blocked');
    assert.ok(step.blockers.some((b) => b.kind === 'unparseable_exception_conditions'));
  });

  await t.test('8. COMPLEMENTS does not become hard dependency', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    // Proven dependencies must NOT include COMPLEMENTS
    assert.equal(report.provenDependencies.length, 0);
    // COMPLEMENTS yields ambiguous precedence, not proven dependency
    assert.ok(report.suggestiveOrdering.some((s) => s.kind === 'ambiguous_precedence' || s.kind === 'source_order_only' || s.kind === 'source_derived_ordering'));
  });

  await t.test('9. ambiguous step precedence is reported', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.ok(report.gaps.some((g) => g.kind === 'ambiguous_precedence'));
    assert.ok(report.blockers.some((b) => b.kind === 'ambiguous_precedence'));
  });

  await t.test('10. deterministic + HITL mixed workflow produces per-step evidence correctly', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-mixed-workflow-graph'));
    const section = ['Finance', 'Reconciliation'] as const;

    const capRuleId = XoirNodeId('cap_calc');
    const ruleId = XoirNodeId('rule_calc');
    graph.createAndAddNode({
      id: capRuleId,
      kind: 'capability',
      properties: { name: 'Calculate Total' },
      sourceRefs: [{ documentPath: 'doc.pdf', sectionPath: [...section] }],
    });
    graph.createAndAddNode({
      id: ruleId,
      kind: 'decision_node',
      properties: {
        question: 'claim_total > 500',
        outcome: 'match',
        structuredCondition: {
          type: 'comparison',
          field: 'claim_total',
          operator: '>',
          value: 500,
        },
      },
    });
    graph.createAndAddEdge({ id: XoirEdgeId('e_r'), kind: 'REQUIRES', fromId: capRuleId, toId: ruleId });

    const capActionId = XoirNodeId('cap_approve');
    const actionId = XoirNodeId('kn_approve_act');
    graph.createAndAddNode({
      id: capActionId,
      kind: 'capability',
      properties: { name: 'Approve Payout' },
      sourceRefs: [{ documentPath: 'doc.pdf', sectionPath: [...section] }],
    });
    graph.createAndAddNode({
      id: actionId,
      kind: 'concept',
      properties: { definition: 'Approve final payout' },
      subtype: 'action',
      sourceRefs: [{ documentPath: 'doc.pdf', sectionPath: [...section] }],
    });
    graph.createAndAddEdge({ id: XoirEdgeId('e_a'), kind: 'REQUIRES', fromId: capActionId, toId: actionId });

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.equal(report.steps.length, 2);

    const calcStep = report.steps.find((s) => s.capabilityId === 'cap_calc')!;
    assert.equal(calcStep.strategyEvidence.category, 'deterministic');
    assert.equal(calcStep.authority, 'proven');

    const approveStep = report.steps.find((s) => s.capabilityId === 'cap_approve')!;
    assert.equal(approveStep.strategyEvidence.category, 'hitl');
    assert.equal(approveStep.authority, 'proven');
  });

  await t.test('11. workflow with unresolved steps becomes not_executable_yet', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.equal(report.status, 'not_executable_yet');
  });

  await t.test('12. semantically invalid workflow is distinguished from merely incomplete workflow', () => {
    const graph = XoirGraph.create(XoirGraphId('audit-circular-graph'));
    const cap1 = XoirNodeId('cap_1');
    const cap2 = XoirNodeId('cap_2');

    graph.createAndAddNode({ id: cap1, kind: 'capability', properties: { name: 'Cap 1' } });
    graph.createAndAddNode({ id: cap2, kind: 'capability', properties: { name: 'Cap 2' } });

    // Precedence cycle
    graph.createAndAddEdge({ id: XoirEdgeId('e_c1'), kind: 'REQUIRES', fromId: cap1, toId: cap2 });
    graph.createAndAddEdge({ id: XoirEdgeId('e_c2'), kind: 'REQUIRES', fromId: cap2, toId: cap1 });

    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report = auditWorkflowExecutability(wf, graph);

    assert.equal(report.status, 'semantically_invalid');
    assert.ok(report.blockers.some((b) => b.kind === 'circular_dependency'));
  });

  await t.test('13. deterministic repeated runs produce identical audit output', () => {
    const graph = buildReconciliationSectionFixtureGraph();
    const composeResult = composeWorkflows(graph);
    assert.equal(composeResult.ok, true);
    if (!composeResult.ok) return;

    const [wf] = composeResult.value;
    const report1 = auditWorkflowExecutability(wf, graph);
    const report2 = auditWorkflowExecutability(wf, graph);

    assert.deepEqual(report1, report2);
  });
});
