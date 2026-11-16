/**
 * ADR 0030 decision 6 — the 15% scope-ambiguity margin, validated against labelled goal-selection cases. Each case says
 * what a careful operator would want: the named workflow selected, or one clarification question. The margin stays
 * provisional; a labelled case that fails here is the evidence for changing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateWorkflow } from '@xo/workflow-composer';
import { goalSpecification, selectWorkflowScope, SCOPE_AMBIGUITY_MARGIN } from '../src/index.js';

const wf = (id: string, name: string, section: string, steps: readonly string[]): CandidateWorkflow =>
  ({
    id,
    name,
    processGrouping: { sectionPath: [section] },
    steps: steps.map((capabilityName) => ({ capabilityName })),
  }) as unknown as CandidateWorkflow;

const CATALOGUE = [
  wf('refund', 'Refund approval', 'Refunds', ['Check the refund amount', 'Approve the refund', 'Notify the customer']),
  wf('chargeback', 'Chargeback handling', 'Disputes', ['Record the chargeback', 'Collect evidence', 'Respond to the bank']),
  wf('onboard', 'Employee onboarding', 'People', ['Create the accounts', 'Issue a laptop', 'Schedule the induction']),
  wf('offboard', 'Employee offboarding', 'People', ['Revoke the accounts', 'Collect the laptop', 'Close payroll']),
  wf('invoice', 'Invoice payment', 'Finance', ['Match the invoice to the order', 'Approve the payment', 'Pay the supplier']),
  wf('expense', 'Expense claim payment', 'Finance', ['Check the receipts', 'Approve the payment', 'Pay the employee']),
];

interface Case {
  readonly goal: Parameters<typeof goalSpecification>[0];
  readonly expect: string | 'clarify' | 'no_match';
  readonly why: string;
}

const CASES: readonly Case[] = [
  { goal: { text: 'approve a customer refund' }, expect: 'refund', why: 'distinctive words' },
  { goal: { text: 'respond to a chargeback from the bank' }, expect: 'chargeback', why: 'distinctive words' },
  {
    goal: { text: 'onboard a new employee' },
    expect: 'clarify',
    why: '"employee" fits onboarding and offboarding equally; "onboard" is not a word of either name',
  },
  { goal: { text: 'employee onboarding' }, expect: 'onboard', why: 'the workflow name' },
  { goal: { text: 'employee offboarding: revoke the accounts' }, expect: 'offboard', why: 'name plus a step' },
  { goal: { text: 'approve the payment' }, expect: 'clarify', why: 'both payment workflows have this step' },
  { goal: { text: 'approve the payment', needs: ['Pay the supplier'] }, expect: 'invoice', why: 'a needed step decides' },
  { goal: { text: 'pay an expense claim' }, expect: 'expense', why: 'distinctive words' },
  { goal: { text: 'payment', section: 'Finance' }, expect: 'clarify', why: 'section and word fit both finance workflows' },
  { goal: { text: 'collect' }, expect: 'clarify', why: 'collect evidence vs collect the laptop' },
  { goal: { text: 'collect the laptop from a leaver', section: 'People' }, expect: 'offboard', why: 'section plus words' },
  { goal: { text: 'renew the office lease' }, expect: 'no_match', why: 'nothing in the catalogue' },
];

test(`the ${SCOPE_AMBIGUITY_MARGIN * 100}% ambiguity margin decides every labelled case as an operator would`, () => {
  const wrong: string[] = [];
  for (const c of CASES) {
    const r = selectWorkflowScope(CATALOGUE, goalSpecification(c.goal));
    const got = r.status === 'selected' ? r.workflowId : r.status === 'needs_clarification' ? 'clarify' : 'no_match';
    if (got !== c.expect) wrong.push(`"${c.goal.text}": expected ${c.expect} (${c.why}), got ${got}`);
  }
  assert.deepEqual(wrong, []);
});

test('the margin never selects silently between two workflows that score the same', () => {
  for (const c of CASES) {
    const r = selectWorkflowScope(CATALOGUE, goalSpecification(c.goal));
    if (r.status !== 'selected') continue;
    const [best, next] = r.ranking;
    assert.ok(next === undefined || best!.score > next.score, `"${c.goal.text}" was selected over an equal score`);
  }
});
