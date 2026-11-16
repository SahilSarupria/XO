/**
 * ADR 0030 — generation emits every Workflow IR construct when, and only when, its evidence exists: act/compensate from a
 * workspace connector binding, branch from rule outcomes that name later steps, wait and deadlines stated by the source,
 * for_each and extract stated by the goal. Each case is validated by the package validator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import type { CandidateWorkflow } from '@xo/workflow-composer';
import { validateWorkflowComponent, type Step } from '@xo/workflow-ir';
import { buildCapabilityInventory, lowerCandidateWorkflow, statedDeadlineMs, statedWaitMs, type ConnectorBinding } from '../src/index.js';

const ref = [{ documentPath: 'src_doc', sectionPath: ['Claims'], pages: [1] }];

function graph(): XoirGraph {
  const g = XoirGraph.create(XoirGraphId('g'));
  const cap = (id: string, name: string, extra: Record<string, unknown> = {}) =>
    g.createAndAddNode({
      id: XoirNodeId(id),
      kind: 'capability',
      properties: { name, description: `${name}.`, ...extra },
      confidence: 0.9,
      sourceRefs: ref,
    });
  // 1. a rule: big claims are escalated to the claims manager, small ones are paid out
  cap('cap_1_assess', 'Assess the claim', { inputs: ['claim amount'] });
  g.createAndAddNode({
    id: XoirNodeId('rule_big'),
    kind: 'heuristic',
    properties: {
      condition: 'the claim amount exceeds 1000',
      action: 'escalate to the claims manager',
      exceptionConditions: [],
      structuredCondition: { type: 'comparison', field: 'claim amount', operator: '>', value: 1000 },
    },
  });
  g.createAndAddNode({
    id: XoirNodeId('rule_small'),
    kind: 'heuristic',
    properties: {
      condition: 'the claim amount is at most 1000',
      action: 'pay out the claim',
      exceptionConditions: [],
      structuredCondition: { type: 'comparison', field: 'claim amount', operator: '<=', value: 1000 },
    },
  });
  g.createAndAddEdge({ id: XoirEdgeId('e1'), kind: 'REQUIRES', fromId: XoirNodeId('rule_big'), toId: XoirNodeId('cap_1_assess') });
  g.createAndAddEdge({ id: XoirEdgeId('e2'), kind: 'REQUIRES', fromId: XoirNodeId('rule_small'), toId: XoirNodeId('cap_1_assess') });
  // 2. a person's task with a stated wait and deadline
  cap('cap_2_escalate', 'Escalate to the claims manager', {
    metadata: {
      understanding: 'manual-step',
      'step.actions': 'Wait 24 hours for the adjuster report, then escalate to the claims manager.',
      'step.doneWhen': 'The manager has decided within 3 days.',
      'step.owner': 'Claims handler',
    },
  });
  // 3. a declared operation, bound by the workspace to a connector with an undo
  cap('cap_3_pay', 'Pay out the claim', {
    inputs: ['claim amount: number', 'account: string'],
    outputs: ['payment id: string'],
    inputTypes: { 'claim amount': 'number', account: 'string' },
    metadata: { sourceExtractor: 'structured-operation' },
  });
  return g;
}

const candidate: CandidateWorkflow = {
  id: 'cw_claims',
  name: 'Claims handling',
  description: 'Assess, escalate or pay.',
  steps: [
    ['cap_1_assess', 'Assess the claim'],
    ['cap_2_escalate', 'Escalate to the claims manager'],
    ['cap_3_pay', 'Pay out the claim'],
  ].map(([capabilityId, capabilityName], order) => ({
    id: `s${order}` as never,
    order,
    capabilityId: capabilityId!,
    capabilityName: capabilityName!,
    description: '',
    rationale: { kind: 'tie_break' } as never,
    confidence: 0.9,
    evidence: [],
  })),
  sourceCapabilityIds: ['cap_1_assess', 'cap_2_escalate', 'cap_3_pay'],
  gaps: [],
  requiresHumanDecision: false,
  confidence: 0.9,
  generatedAt: '1970-01-01T00:00:00.000Z',
};

const pay: ConnectorBinding = {
  capability: 'Pay out the claim',
  connector: 'payments',
  kind: 'http',
  operation: 'create_payment',
  sideEffect: 'write',
  compensation: { operation: 'void_payment', sideEffect: 'write' },
  adapter: 'payments-adapter',
};

function lower(opts: { bound?: boolean; intake?: 'text'; forEach?: string } = {}) {
  const g = graph();
  const bindings = new Map(opts.bound === false ? [] : [[pay.capability, pay]]);
  const inventory = buildCapabilityInventory(g, { externalBindings: bindings, availableAdapters: new Set(['payments-adapter']) });
  return lowerCandidateWorkflow(g, candidate, inventory, {
    connectorBindings: bindings,
    ...(opts.intake !== undefined ? { intake: opts.intake } : {}),
    ...(opts.forEach !== undefined ? { forEach: opts.forEach } : {}),
  });
}
const byId = (steps: readonly Step[], id: string): Step => steps.find((s) => s.id === id)!;

test('every construct from its evidence: decide → branch → wait → approve (stated deadline) → act with undo', () => {
  const low = lower();
  assert.deepEqual(low.issues, []);
  assert.equal(low.complete, true);
  const wf = low.component!.workflows[0]!;
  assert.deepEqual(
    wf.steps.map((s) => s.type),
    // UW-7 (ADR 0033): the person's task is followed by its not-done escalation.
    ['decide', 'branch', 'wait', 'approve', 'escalate', 'act', 'compensate'],
  );
  const branch = byId(wf.steps, 's1_assess_claim_route');
  assert.ok(branch.type === 'branch');
  if (branch.type === 'branch')
    assert.deepEqual(
      branch.cases.map((c) => c.route),
      ['s2_escalate_to_claims_manager', 's3_pay_out_claim'],
    );
  const wait = wf.steps.find((s) => s.type === 'wait')!;
  assert.ok(wait.type === 'wait' && wait.for.kind === 'timer' && wait.for.delayMs === 24 * 3_600_000);
  const approve = byId(wf.steps, 's2_escalate_to_claims_manager');
  assert.equal(approve.timeoutMs, 3 * 86_400_000, 'the deadline the source states');
  assert.match(approve.runIf ?? '', /route == 's2_escalate_to_claims_manager'/);
  const act = byId(wf.steps, 's3_pay_out_claim');
  assert.ok(act.type === 'act');
  if (act.type === 'act') {
    assert.equal(act.connector, 'payments');
    assert.equal(act.idempotencyKey, '{{workflow.id}}:{{run.id}}:{{step.id}}');
    assert.equal(act.compensatedBy, 's3_pay_out_claim_undo');
    assert.match(act.runIf ?? '', /route == 's3_pay_out_claim'/);
  }
  assert.deepEqual(low.component!.connectors, [
    {
      id: 'payments',
      kind: 'http',
      operations: [
        { name: 'create_payment', sideEffect: 'write' },
        { name: 'void_payment', sideEffect: 'write' },
      ],
    },
  ]);
  assert.deepEqual(wf.requiresFeatures, ['approve', 'compensation', 'rules', 'wait_timer']);
  assert.equal(validateWorkflowComponent(low.component).valid, true);
});

test('without a connector binding the act step is reported, never invented', () => {
  const low = lower({ bound: false });
  assert.equal(low.complete, false);
  assert.ok(low.issues.some((i) => i.capabilityId === 'cap_3_pay' && i.severity === 'blocking'));
  assert.ok(!low.component!.workflows[0]!.steps.some((s) => s.type === 'act'));
});

test('a goal that says cases arrive as text adds one quoted extract; a goal "for each" fans out with per-item keys', () => {
  const text = lower({ intake: 'text' });
  assert.equal(text.validation.valid, true, JSON.stringify(text.validation.issues));
  const wf = text.component!.workflows[0]!;
  assert.equal(wf.steps[0]!.type, 'extract');
  const decide = byId(wf.steps, 's1_assess_claim');
  assert.deepEqual(decide.inputs?.['claim_amount'], { from: 'steps.extract_facts.claim_amount' });
  assert.ok(wf.requiresFeatures?.includes('model_extract'));

  const each = lower({ forEach: 'claim' });
  assert.equal(each.validation.valid, true, JSON.stringify(each.validation.issues));
  const ewf = each.component!.workflows[0]!;
  assert.deepEqual(ewf.forEach, { over: 'claim_items', maxItems: 1000, concurrency: 1 });
  const act = byId(ewf.steps, 's3_pay_out_claim');
  assert.ok(act.type === 'act' && act.idempotencyKey!.includes('{{run.index}}'));
  assert.deepEqual(byId(ewf.steps, 's1_assess_claim').inputs?.['claim_amount'], { from: 'item.claim_amount' });
});

test('stated waits and deadlines are read only from explicit phrases', () => {
  assert.equal(statedWaitMs('Wait two days before calling back.'), 2 * 86_400_000);
  assert.equal(statedWaitMs('Call back soon.'), undefined);
  assert.equal(statedDeadlineMs('Reply within 48 hours.'), 48 * 3_600_000);
  assert.equal(statedDeadlineMs('Reply quickly.'), undefined);
});
