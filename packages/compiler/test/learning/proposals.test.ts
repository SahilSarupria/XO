import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AmendmentLedger, approveProposal, proposeFromOutcomes, type VerifiedOutcome } from '../../src/learning/proposals.js';

// Domain-neutral wording. Learning is GOVERNED: verified evidence -> proposal -> human approval -> append-only amendment.
const out = (id: string, kind: VerifiedOutcome['kind'], by = 'alice', rule = 'rule_1', extra: Partial<VerifiedOutcome> = {}): VerifiedOutcome => ({
  id, ruleNodeId: rule, ruleLabel: 'the request must be rejected', kind, verifiedBy: by, verifiedAt: '2026-05-01T10:00:00Z', evidenceRef: `case-${id}`, ...extra,
});
const deepFreeze = <T>(o: T): T => {
  if (o !== null && typeof o === 'object') for (const v of Object.values(o as object)) deepFreeze(v);
  return Object.freeze(o);
};

test('repeated incorrect outcomes from at least two independent verifiers produce a review proposal citing every evidence id', () => {
  const r = proposeFromOutcomes([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob'), out('o3', 'incorrect', 'alice')]);
  assert.equal(r.proposals.length, 1);
  const p = r.proposals[0]!;
  assert.equal(p.kind, 'review-rule');
  assert.equal(p.status, 'proposed');
  assert.deepEqual([...p.evidence].sort(), ['o1', 'o2', 'o3']);
  assert.match(p.id, /^prop_[0-9a-f]{16}$/);
});

test('below the thresholds nothing is proposed: too few outcomes, or all from one verifier', () => {
  assert.equal(proposeFromOutcomes([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob')]).proposals.length, 0);
  assert.equal(proposeFromOutcomes([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'alice'), out('o3', 'incorrect', 'alice')]).proposals.length, 0);
});

test('unverified or malformed evidence is IGNORED and reported, never counted', () => {
  const r = proposeFromOutcomes([
    out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob'),
    out('o3', 'incorrect', '   '),                                  // no accountable verifier
    out('o4', 'incorrect', 'carol', 'rule_1', { verifiedAt: 'last tuesday' }), // not a date
    out('o5', 'incorrect', 'dave', 'rule_1', { evidenceRef: '' }),   // no evidence reference
  ]);
  assert.equal(r.proposals.length, 0);
  assert.deepEqual(r.ignored.map((i) => i.outcomeId).sort(), ['o3', 'o4', 'o5']);
  assert.ok(r.ignored.every((i) => i.reason.length > 0));
});

test('human overrides suggest an exception candidate; insufficient information suggests a clarification; sustained correctness only a confidence candidate', () => {
  const over = proposeFromOutcomes([out('a', 'overridden-by-human', 'alice'), out('b', 'overridden-by-human', 'bob'), out('c', 'overridden-by-human', 'carol')]);
  assert.equal(over.proposals[0]!.kind, 'add-exception-candidate');
  const info = proposeFromOutcomes([out('a', 'insufficient-information', 'alice'), out('b', 'insufficient-information', 'bob'), out('c', 'insufficient-information', 'carol')]);
  assert.equal(info.proposals[0]!.kind, 'clarification-needed');
  const ok = proposeFromOutcomes(Array.from({ length: 10 }, (_, i) => out(`k${i}`, 'correct', i % 2 ? 'alice' : 'bob')));
  assert.equal(ok.proposals[0]!.kind, 'raise-confidence-candidate');
});

test('a rule with ANY incorrect outcome never gets a confidence-raising proposal', () => {
  const r = proposeFromOutcomes([...Array.from({ length: 10 }, (_, i) => out(`k${i}`, 'correct', i % 2 ? 'alice' : 'bob')), out('bad', 'incorrect', 'carol')]);
  assert.equal(r.proposals.some((p) => p.kind === 'raise-confidence-candidate'), false);
});

test('proposing is pure and deterministic: inputs are never mutated and ids are content-addressed', () => {
  const input = deepFreeze([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob'), out('o3', 'incorrect', 'carol')]);
  const a = proposeFromOutcomes(input);
  const b = proposeFromOutcomes([...input].reverse());
  assert.deepEqual(a, b);
});

test('approval requires an accountable approver who did not verify the evidence (separation of duties)', () => {
  const p = proposeFromOutcomes([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob'), out('o3', 'incorrect', 'carol')]).proposals[0]!;
  assert.throws(() => approveProposal(p, { approvedBy: '  ', decision: 'approve' }), /approver/i);
  assert.throws(() => approveProposal(p, { approvedBy: 'alice', decision: 'approve' }), /verif/i);
  const a = approveProposal(p, { approvedBy: 'dana', decision: 'approve', note: 'confirmed with the owner' }, new Date('2026-06-01T00:00:00Z'));
  assert.equal(a.decision, 'approve');
  assert.equal(a.proposalId, p.id);
  assert.equal(a.approvedAt, '2026-06-01T00:00:00.000Z');
});

test('a tampered proposal (content no longer matches its id) cannot be approved', () => {
  const p = proposeFromOutcomes([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob'), out('o3', 'incorrect', 'carol')]).proposals[0]!;
  const forged = { ...p, summary: 'silently delete this rule' };
  assert.throws(() => approveProposal(forged, { approvedBy: 'dana', decision: 'approve' }), /tamper|does not match/i);
});

test('the ledger is append-only: one decision per proposal, nothing is removed or rewritten', () => {
  const p = proposeFromOutcomes([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob'), out('o3', 'incorrect', 'carol')]).proposals[0]!;
  const ledger = new AmendmentLedger();
  const a = approveProposal(p, { approvedBy: 'dana', decision: 'reject', note: 'rule is right; the cases were mislabelled' });
  ledger.append(a);
  assert.throws(() => ledger.append(approveProposal(p, { approvedBy: 'erin', decision: 'approve' })), /already decided/i);
  assert.equal(ledger.list().length, 1);
  assert.throws(() => (ledger.list() as unknown[]).push({}), TypeError); // returned view is frozen
  assert.deepEqual(ledger.approvedFor('rule_1'), []); // a rejection never counts as approved
});

test('only APPROVED amendments are reported as approved for a rule, and approval never edits the proposal or the rule', () => {
  const p = proposeFromOutcomes([out('o1', 'incorrect', 'alice'), out('o2', 'incorrect', 'bob'), out('o3', 'incorrect', 'carol')]).proposals[0]!;
  const frozen = deepFreeze({ ...p });
  const ledger = new AmendmentLedger();
  ledger.append(approveProposal(frozen, { approvedBy: 'dana', decision: 'approve' }));
  assert.equal(ledger.approvedFor('rule_1').length, 1);
  assert.equal(frozen.status, 'proposed'); // the proposal object itself is untouched
});
