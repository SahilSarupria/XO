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

import { evaluateTree, createCapabilityLayer } from '@xo/capability-layer';
import { INSURANCE_TREE, INSURANCE_ENTRIES, INSURANCE_GOLD_FACTS, buildInsuranceGoldXo, INSURANCE_MANUAL } from '../src/index.js';

test('insurance gold tree agrees with the independent oracle on 20,000 random cases', () => {
  let s = 99;
  const r = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  for (let i = 0; i < 20000; i++) {
    const f = {
      claim_type: (['collision', 'glass', 'theft'] as const)[ri(0, 2)]!,
      injury_involved: r() < 0.1,
      policy_in_force: r() < 0.9,
      claims_last_12m: ri(0, 4),
      days_to_report: ri(0, 120),
      police_report_filed: r() < 0.7,
      repair_estimate_usd: ri(0, 60000),
      vehicle_value_usd: ri(1000, 60000),
      rental_coverage: r() < 0.5,
      rental_days: ri(0, 30),
    };
    const o = adjudicateInsurance(f);
    const t = evaluateTree(INSURANCE_TREE, f as unknown as Record<string, unknown>);
    assert.equal(t.ok, true);
    if (!t.ok) return;
    assert.equal(t.output['decision'], o.decision, JSON.stringify(f));
    assert.ok(Math.abs(Number(t.output['payout_usd']) - o.payout_usd) < 0.01, JSON.stringify(f));
    assert.equal(t.output['escalation_target'], o.escalation_target);
  }
});

test('insurance gold XO: builds, loads executable, and carries every gold fact; every number in the manual is in the knowledge', () => {
  const bundle = buildInsuranceGoldXo();
  const layer = createCapabilityLayer(bundle, { host: { family: 'claude', capabilities: ['chat', 'tool_use'] } });
  const receipt = layer.emitLoadReceipt();
  assert.ok(receipt.executableSafetyRules >= 1);
  const texts = INSURANCE_ENTRIES.map((e) => `${e.title} ${e.text}`);
  const missing = INSURANCE_GOLD_FACTS.filter((f) => !texts.some((t) => f.patterns.every((p) => p.test(t)))).map((f) => f.id);
  assert.deepEqual(missing, []);
  // the manual's figures must all appear in the gold knowledge (no rule lost in transcription)
  const kn = texts.join(' ');
  for (const n of ['30 days', '90 days', '75%', '$40', '14 days', '$15,000', '2 or more', '12 months']) {
    assert.ok(INSURANCE_MANUAL.includes(n.replace('2 or more', '2 or more')) && kn.includes(n), n);
  }
});

test('insurance: compiled knowledge coverage vs gold (recorded, not asserted high)', async () => {
  const { insuranceKnowledgeCoverage } = await import('../src/index.js');
  const c = await insuranceKnowledgeCoverage();
  writeFileSync((process.env['XO_SECOND_DOMAIN_OUT'] ?? '/tmp/second-domain.json').replace('.json', '-coverage.json'), JSON.stringify(c));
  assert.ok(c.total === 11);
});

test('explicit field mapping (no heuristic binder) reproduces the reviewed result, and an unmapped input fails closed', async () => {
  const { compileInsuranceReviewed, scoreWithMapping, INSURANCE_FIELD_MAP } = await import('../src/index.js');
  const run = await compileInsuranceReviewed();
  const full = scoreWithMapping(run.artifacts, INSURANCE_FIELD_MAP);
  assert.equal(full.unmappedInputs.length, 0);
  assert.equal(full.agreement, 1);
  assert.equal(full.wrongConfident, 0);
  const { rental_days: _drop, ...partial } = INSURANCE_FIELD_MAP;
  const gap = scoreWithMapping(run.artifacts, partial);
  assert.deepEqual(gap.unmappedInputs, ['rental_days']);
  assert.equal(gap.wrongConfident, 0, 'a missing mapping must never produce a confident wrong answer');
  assert.ok(gap.agreement < 1);
});
