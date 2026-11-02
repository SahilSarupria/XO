import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { adjudicateInsurance, generateInsuranceTasks, scoreSecondDomain } from '../src/index.js';

test('insurance oracle: hand-checked cases', () => {
  const f = {
    claim_type: 'collision',
    injury_involved: false,
    policy_in_force: true,
    claims_last_12m: 0,
    days_to_report: 10,
    police_report_filed: false,
    repair_estimate_usd: 3000,
    vehicle_value_usd: 20000,
    rental_coverage: false,
    rental_days: 0,
  } as const;
  assert.deepEqual(adjudicateInsurance(f), { decision: 'approve', payout_usd: 2500, escalation_target: null });
  assert.equal(adjudicateInsurance({ ...f, injury_involved: true, policy_in_force: false }).escalation_target, 'Casualty Unit');
  assert.equal(adjudicateInsurance({ ...f, claims_last_12m: 2, days_to_report: 99 }).escalation_target, 'SIU');
  assert.equal(adjudicateInsurance({ ...f, claim_type: 'glass', days_to_report: 90 }).decision, 'approve');
  assert.equal(adjudicateInsurance({ ...f, claim_type: 'glass', days_to_report: 91 }).decision, 'deny');
  assert.equal(adjudicateInsurance({ ...f, repair_estimate_usd: 16000 }).decision, 'escalate'); // total loss pays 19500 > 15000
  assert.equal(adjudicateInsurance({ ...f, vehicle_value_usd: 12000, repair_estimate_usd: 10000 }).payout_usd, 11500); // total loss: 12000 - 500
  assert.equal(adjudicateInsurance({ ...f, rental_coverage: true, rental_days: 20 }).payout_usd, 3060);
  assert.equal(
    adjudicateInsurance({ ...f, vehicle_value_usd: 40000, repair_estimate_usd: 16000, rental_coverage: false }).payout_usd,
    15500 > 15000 ? 0 : 15500,
  );
});

test('insurance tasks are seeded and cover every stratum', () => {
  const a = generateInsuranceTasks(1);
  assert.deepEqual(a, generateInsuranceTasks(1));
  assert.ok(new Set(a.map((t) => t.stratum)).size >= 10);
  assert.ok(
    a.some((t) => t.expected.decision === 'escalate') &&
      a.some((t) => t.expected.decision === 'deny') &&
      a.some((t) => t.expected.decision === 'approve'),
  );
});

test('held-out domain: measure the untuned compiler (written to scratch, asserts only honesty invariants)', async () => {
  const s = await scoreSecondDomain();
  writeFileSync(process.env['XO_SECOND_DOMAIN_OUT'] ?? '/tmp/second-domain.json', JSON.stringify(s, null, 2));
  assert.equal(typeof s.treeEmitted, 'boolean');
  // recorded fact about the pattern extractor on a manual it was not built for: it understands few sentences…
  assert.ok(s.decisionRecognized < s.decisionSentences / 2, 'if this starts failing the extractor improved: update the docs table');
  // …but it must fail closed: no confidently wrong decision from the sentences it did not understand
  assert.equal(s.wrongConfident, 0);
  // honesty invariant: an unformalised rule must never silently approve — wrong confident answers are counted, not hidden
  assert.equal(s.failedClosed + s.wrongConfident + Math.round((s.agreement ?? 0) * s.tasks), s.tasks);
});

test('held-out domain after operator review (checks still enforced)', async () => {
  const { compileInsuranceReviewed, scoreSecondDomain } = await import('../src/index.js');
  const run = await compileInsuranceReviewed();
  const s = await scoreSecondDomain(undefined, run.artifacts, { policyholder_who_has_made_2_or: (f) => Number(f['claims_last_12m']) >= 2 });
  writeFileSync(
    (process.env['XO_SECOND_DOMAIN_OUT'] ?? '/tmp/second-domain.json').replace('.json', '-reviewed.json'),
    JSON.stringify(
      { refused: run.refused, accepted: run.accepted, rejected: run.rejected, stillUnreviewed: run.stillUnreviewed, score: s },
      null,
      2,
    ),
  );
  assert.equal(s.failedClosed + s.wrongConfident + Math.round((s.agreement ?? 0) * s.tasks), s.tasks);
  assert.equal(run.refused.length, 0);
  assert.equal(run.stillUnreviewed.length, 0);
  assert.equal(s.wrongConfident, 0);
  assert.ok((s.agreement ?? 0) >= 0.95);
});
