import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { synthesizePolicyArtifacts } from '@xo/compiler';
import { evaluateTree } from '@xo/capability-layer';
import { manualMarkdown } from '../src/index.js';

const compile = (text: string) => synthesizePolicyArtifacts([{ text, title: 'Test policy', sourcePath: 'p.md' }]);
const run = (tree: Parameters<typeof evaluateTree>[0], facts: Record<string, unknown>) =>
  evaluateTree(tree, facts) as { ok: boolean; output: Record<string, unknown> };
// facts are named from the document's own words, so these are the names the freight manual produces
const base = {
  claim_type: 'damage',
  commodity_class: 'general',
  claimant_claims_last_90d: 0,
  days_to_file: 5,
  damage_noted_on_proof_of_delivery: false,
  shipper_packed_freight_and_packaging_inadequate: false,
  affected_weight_lb: 100,
  declared_value_usd: 0,
  full_value_coverage_endorsement: false,
  damage_pct: 100,
  salvage_value_usd: 0,
};

describe('policy synthesis follows the document, not a baked-in constant', () => {
  it('recognizes every decision sentence of the Halvorsen manual and reports none unreviewed', () => {
    const a = compile(manualMarkdown());
    assert.deepEqual(a.review.unrecognized, []);
    assert.equal(a.review.failClosedPaths.length, 0);
    assert.equal(a.review.status, 'unreviewed');
    assert.ok(a.trees?.[0] !== undefined);
  });

  it('changing the numbers in the text changes the tree’s behaviour (single source of truth)', () => {
    const original = compile(manualMarkdown()).trees![0]!;
    const edited = compile(
      manualMarkdown()
        .replace('within 9 days after delivery', 'within 12 days after delivery')
        .replace('deductible of $150 per claim', 'deductible of $200 per claim'),
    ).trees![0]!;
    const late = { ...base, days_to_file: 11 };
    assert.equal(run(original, late).output['decision'], 'deny');
    assert.notEqual(run(edited, late).output['decision'], 'deny');
    // 100 lb general = $250 cap; deductible 150 → 100, deductible 200 → 50
    assert.equal(run(original, base).output['payout_usd'], 100);
    assert.equal(run(edited, base).output['payout_usd'], 50);
  });

  it('a lowered escalation threshold takes effect and the output guard follows it', () => {
    const a = compile(manualMarkdown().replace('more than $25,000, escalate', 'more than $200, escalate'));
    const r = run(a.trees![0]!, { ...base, affected_weight_lb: 1000 });
    assert.equal(r.output['decision'], 'escalate');
    assert.equal(r.output['escalation_target'], 'Claims Manager');
    assert.ok(a.safetyRules!.some((s) => s.when.includes('payout_usd > 200')));
  });

  it('every worked example is a path the tree actually takes', () => {
    const a = compile(manualMarkdown());
    const lines = a.reasoningTraces!.split('\n').map((l) => JSON.parse(l) as { conclusion: { decision: string }; steps: string[] });
    assert.ok(lines.length >= 3);
    for (const l of lines) assert.ok(l.steps.length > 0 && typeof l.conclusion.decision === 'string');
  });
});

describe('a differently worded document: understood parts become a tree, the rest fails closed and is listed', () => {
  const doc = [
    '# Travel Reimbursement Policy',
    '',
    '## Eligibility (R1)',
    '',
    '**Restricted destinations.** A request for travel to a sanctioned country is routed to the Compliance Office regardless of the amount.',
    '',
    '## Filing (R2)',
    '',
    '**Filing deadline.** Expense reports must be submitted within 30 days after the trip.',
    '',
    '## Approval (R3)',
    '',
    '**Approval limit.** If the total reimbursement is more than $2,000, escalate to the Finance Director; managers may never approve more than $2,000.',
    '',
    '**Per diem.** Meals are reimbursed at $60 per day and only for days away from home.',
  ].join('\n');

  it('extracts gate, window and threshold; lists what it did not understand; never decides on a guess', () => {
    const a = compile(doc);
    const tree = a.trees?.[0];
    assert.ok(tree !== undefined, 'a tree is emitted for the understood part');
    assert.ok(
      a.review.unrecognized.some((u) => /per day/.test(u.sentence)),
      'the per-diem rule is reported, not guessed',
    );
    assert.equal(
      run(tree, { request_for_travel_to_sanctioned_country: true, days_to_submit: 1, total_reimbursement_usd: 10 }).output[
        'escalation_target'
      ],
      'Compliance Office',
    );
    assert.equal(
      run(tree, { request_for_travel_to_sanctioned_country: false, days_to_submit: 45, total_reimbursement_usd: 10 }).output['decision'],
      'deny',
    );
    assert.equal(
      run(tree, { request_for_travel_to_sanctioned_country: false, days_to_submit: 5, total_reimbursement_usd: 5000 }).output[
        'escalation_target'
      ],
      'Finance Director',
    );
    const onTime = run(tree, { request_for_travel_to_sanctioned_country: false, days_to_submit: 10, total_reimbursement_usd: 100 });
    assert.equal(
      onTime.output['decision'],
      'escalate',
      'an on-time case cannot be approved by a tree that did not understand the payout rules',
    );
    assert.equal(onTime.output['reason_code'], 'UNFORMALIZED_RULE');
    assert.ok(a.review.failClosedPaths.includes('expense'));
  });

  it('a document with no decision structure yields no tree at all', () => {
    const a = compile('# Notes\n\n## About (R1)\n\n**Overview.** The office is on the third floor and has a kitchen.');
    assert.equal(a.trees, undefined);
    assert.equal(a.safetyRules, undefined);
  });
});

describe('a domain the compiler has never seen: no code change, same behaviour', () => {
  const vendor = [
    '# Vendor Invoice Policy',
    '',
    '## Screening (R1)',
    '',
    '**Restricted vendors.** Any invoice from a vendor whose risk tier is restricted is escalated to the Compliance Office, regardless of the amount.',
    '',
    '## Timing (R2)',
    '',
    '**Submission window.** A standard invoice must be submitted within 45 days after the invoice date. A rush invoice must be submitted within 10 days after the invoice date.',
    '',
    '## Checks (R3)',
    '',
    '**Duplicates.** An invoice is denied when the invoice number was already paid.',
    '',
    '**Approval limit.** If the total payment is more than $10,000, escalate to the Finance Director.',
  ].join('\n');

  it('builds per-kind time limits, gates and a threshold from the text alone', () => {
    const a = compile(vendor);
    const tree = a.trees![0]!;
    const f = {
      invoice_type: 'standard',
      risk_tier: 'approved',
      days_to_submit: 30,
      invoice_number_already_paid: false,
      total_payment_usd: 100,
    };
    assert.ok(
      tree.inputs.some((i) => i.name === 'invoice_type'),
      'the case kind is named from the document ("invoice")',
    );
    assert.equal(run(tree, { ...f, risk_tier: 'restricted' }).output['escalation_target'], 'Compliance Office');
    assert.equal(
      run(tree, { ...f, days_to_submit: 30 }).output['reason_code'],
      'UNFORMALIZED_RULE',
      'in time, no outcome stated → fail closed',
    );
    assert.equal(
      run(tree, { ...f, invoice_type: 'rush', days_to_submit: 30 }).output['decision'],
      'deny',
      'rush limit is 10, standard is 45',
    );
    assert.equal(run(tree, { ...f, invoice_number_already_paid: true }).output['decision'], 'deny');
    assert.equal(run(tree, { ...f, total_payment_usd: 20000 }).output['escalation_target'], 'Finance Director');
    assert.deepEqual([...a.review.failClosedPaths].sort(), ['rush', 'standard']);
  });

  it('contains no vocabulary of any domain in the compiled tree it was not given', () => {
    const json = JSON.stringify(compile(vendor).trees![0]);
    for (const w of ['claim', 'freight', 'commodity', 'hazmat', 'payout', 'delivery']) assert.ok(!json.includes(w), `unexpected "${w}"`);
  });
});
