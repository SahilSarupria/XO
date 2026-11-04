import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateTree } from '@xo/capability-layer';
import { validateAgainstBundle, validateWorkflowComponent } from '@xo/workflow-ir';
import { extractProgram, segmentPolicyText, synthesizePolicyArtifacts, type PolicyArtifacts } from '../../src/policy/index.js';

const fx = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
/** Written for this change; not part of the tuning corpus. */
const LOAN = fx('loan-desk-policy.md');
const art = (text: string, options = {}): PolicyArtifacts => synthesizePolicyArtifacts([{ text, title: 'Loans' }], options);
const decide = (a: PolicyArtifacts, facts: Record<string, unknown>) => {
  const r = evaluateTree(a.trees![0]!, facts);
  assert.ok(r.ok, JSON.stringify(r));
  return r.output;
};
const OK = { library_card: true, borrower_with_3_or_more_overdue: false, loan_usd: 100 };

test('a fully recognized policy compiles to a tree that can deny, escalate AND approve', () => {
  const a = art(LOAN);
  assert.equal(a.review.unrecognized.length, 0);
  assert.deepEqual(a.review.heldApprovals, []);
  assert.deepEqual(decide(a, { ...OK, library_card: false })['decision'], 'deny');
  assert.deepEqual(decide(a, { ...OK, borrower_with_3_or_more_overdue: true })['escalation_target'], 'Circulation Manager');
  assert.deepEqual(decide(a, { ...OK, loan_usd: 2000 })['escalation_target'], 'Director');
  const ok = decide(a, OK);
  assert.equal(ok['decision'], 'approve');
  assert.equal(ok['reason_code'], 'APPROVED');
});

test('the emitted workflows validate, route approvals, and no longer claim "no approving outcome"', () => {
  const a = art(LOAN);
  assert.ok(a.workflows, a.workflowProblems?.join('; '));
  assert.deepEqual(
    validateWorkflowComponent(JSON.parse(JSON.stringify(a.workflows.component))).issues.filter((i) => i.severity === 'error'),
    [],
  );
  assert.deepEqual(validateAgainstBundle(a.workflows.component, { decisionTrees: { trees: a.trees } }).issues, []);
  assert.ok(a.workflows.report.capabilities[0]!.outcomes.includes('approve'));
  assert.equal(
    a.workflows.report.limits.some((l) => l.includes('no approving outcome') || l.includes('HELD')),
    false,
  );
});

test('an approval never pre-empts a refusal, even when the document states the approval first', () => {
  const text = [
    '# Order Policy',
    '',
    '## Rules',
    '',
    '**A1 Members.** If the customer is a verified member, the request is approved.',
    '',
    '**A2 Card.** If there is no library card, the request is rejected.',
  ].join('\n');
  const a = art(text);
  assert.ok(a.trees, 'no tree');
  // a verified member with no card must be refused, not approved
  assert.equal(decide(a, { library_card: false, customer_verified_member: true })['decision'], 'deny');
  assert.equal(decide(a, { library_card: true, customer_verified_member: true })['decision'], 'approve');
});

test('FAIL CLOSED: while any decision sentence is unreviewed an approval is held (escalated), and rulings release it', () => {
  const open = LOAN.replace('## Rules', '## Rules\n\n**L0 Minors.** Staff must use judgement when the borrower is a minor.');
  const a = art(open);
  assert.equal(a.review.unrecognized.length, 1);
  assert.ok(a.review.heldApprovals.length > 0);
  const held = decide(a, OK);
  assert.equal(held['decision'], 'escalate', 'an approval went through over an unreviewed rule');
  assert.equal(held['reason_code'], 'APPROVAL_HELD_UNREVIEWED_RULES');
  // denials and escalations that DO NOT depend on the approval are unaffected
  assert.equal(decide(a, { ...OK, library_card: false })['decision'], 'deny');
  // the report says so, in words
  assert.ok(a.workflows!.report.limits.some((l) => l.includes('HELD')));
  assert.ok(a.workflows!.report.capabilities[0]!.approvalsHeld.length > 0);
  // a reviewer rules the sentence is not a rule: the hold lifts
  const sentence = a.review.unrecognized[0]!.sentence;
  const released = art(open, { ledger: { accepted: [], rejected: [{ sentence, note: 'guidance, not a rule' }] } });
  assert.equal(released.review.unrecognized.length, 0);
  assert.equal(decide(released, OK)['decision'], 'approve');
  // a ruling about a sentence that is not in the document changes nothing (a stale ruling cannot release a hold)
  const stale = art(open, { ledger: { accepted: [], rejected: [{ sentence: 'Some other sentence.' }] } });
  assert.equal(decide(stale, OK)['decision'], 'escalate');
});

test('negated, qualified or compound approvals are never read as approvals', () => {
  for (const sentence of [
    'The desk never pays the replacement value of the device.',
    'A request that fails the card check is not approved.',
    'A request over $50 is approved if the customer has a card and the item is in stock.',
    'Otherwise the request is approved unless the item is restricted.',
    'If the order is under $100, the order is approved.',
    'The desk may pay the replacement value of the device.',
  ]) {
    const ex = extractProgram(segmentPolicyText(`# T\n\n## Rules\n\n**X1 Rule.** ${sentence}`), 'T');
    assert.equal(
      ex.program.steps.some((s) => s.kind === 'finish'),
      false,
      `read as an approval: ${sentence}`,
    );
  }
});

test('abstains instead of guessing the scope: in a document with case kinds, an unscoped refusal stays unrecognized', () => {
  const corpus = readFileSync(fileURLToPath(new URL('../corpus/insurance-triage.md', import.meta.url)), 'utf8');
  const ex = extractProgram(segmentPolicyText(corpus), 'T');
  // "If there is no police report, the claim is denied." belongs to THEFT claims only; an unscoped gate would deny every claim kind
  assert.equal(
    ex.program.steps.some((s) => s.kind === 'gate' && s.when.includes('police_report')),
    false,
  );
  assert.ok(ex.unrecognized.some((u) => u.sentence.includes('no police report')));
});

test('decisionSink "none" emits no connector and no action; the decision is the run result', () => {
  const a = art(LOAN, { workflows: { decisionSink: 'none' } });
  assert.ok(a.workflows, a.workflowProblems?.join('; '));
  const c = a.workflows.component;
  assert.deepEqual(c.connectors, []);
  for (const w of c.workflows)
    assert.equal(
      w.steps.some((s) => s.type === 'act'),
      false,
    );
  assert.deepEqual(
    validateWorkflowComponent(JSON.parse(JSON.stringify(c))).issues.filter((i) => i.severity === 'error'),
    [],
  );
  assert.deepEqual(validateAgainstBundle(c, { decisionTrees: { trees: a.trees } }).issues, []);
  assert.ok(a.workflows.report.limits.some((l) => l.includes('No action is emitted')));
  assert.equal(
    a.workflows.report.limits.some((l) => l.includes('file connector')),
    false,
  );
});

test('a settlement sentence approves AND carries the amount from the quantity the document already named', () => {
  const text = [
    '# Warranty Policy',
    '',
    '## Rules',
    '',
    '**S1 High value.** A replacement worth more than $800 requires approval from the Regional Manager; the desk escalates to the Regional Manager.',
    '',
    '**S2 Settlement.** The desk pays the replacement value of the device.',
  ].join('\n');
  const a = art(text);
  assert.equal(a.review.unrecognized.length, 0);
  assert.ok(a.trees);
  const facts = Object.fromEntries(a.trees[0]!.inputs.map((i) => [i.name, i.type === 'number' ? 640 : false]));
  const out = decide(a, facts);
  assert.equal(out['decision'], 'approve');
  assert.equal(out['amount_usd'], 640, 'the settlement amount was not taken from the named quantity');
  // above the escalation limit it still goes to the person
  assert.equal(decide(a, { ...facts, replacement_usd: 900 })['decision'], 'escalate');
});
