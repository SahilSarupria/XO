import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { synthesizePolicyArtifacts } from '@xo/compiler';
import { evaluateTree } from '@xo/capability-layer';
import { manualMarkdown } from '../src/index.js';

const compile = (text: string) => synthesizePolicyArtifacts([{ text, title: 'Test policy', sourcePath: 'p.md' }]);
const base = {
  claim_type: 'damage',
  commodity_class: 'general',
  claimant_claims_last_90d: 0,
  days_to_file: 5,
  pod_damage_noted: false,
  packaging: 'carrier_packed',
  weight_lb: 100,
  declared_value_usd: 0,
  full_value_coverage: false,
  damage_pct: 100,
  salvage_value_usd: 0,
};

describe('policy synthesis follows the document, not a baked-in constant', () => {
  it('recognizes every decision sentence of the Halvorsen manual and reports none unreviewed', () => {
    const a = compile(manualMarkdown());
    assert.equal(a.review.unrecognized.length, 0);
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
    // 11 days: late under the 9-day window, on time under the 12-day window
    const late = { ...base, days_to_file: 11 };
    assert.equal((evaluateTree(original, late) as { output: { decision: string } }).output.decision, 'deny');
    assert.notEqual((evaluateTree(edited, late) as { output: { decision: string } }).output.decision, 'deny');
    // 100 lb general = $250 cap; deductible 150 → 100, deductible 200 → 50
    assert.equal((evaluateTree(original, base) as { output: { payout_usd: number } }).output.payout_usd, 100);
    assert.equal((evaluateTree(edited, base) as { output: { payout_usd: number } }).output.payout_usd, 50);
  });

  it('a lowered escalation threshold takes effect and the output guard follows it', () => {
    const a = compile(manualMarkdown().replace('more than $25,000, escalate', 'more than $200, escalate'));
    const r = evaluateTree(a.trees![0]!, { ...base, weight_lb: 1000 }) as { output: { decision: string; escalation_target: string } };
    assert.equal(r.output.decision, 'escalate');
    assert.equal(r.output.escalation_target, 'Claims Manager');
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

  it('extracts the filing window, lists what it did not understand, and never decides on a guess', () => {
    const a = compile(doc);
    const tree = a.trees?.[0];
    assert.ok(tree !== undefined, 'a tree is emitted for the understood part');
    assert.ok(
      a.review.unrecognized.some((u) => /sanctioned country/.test(u.sentence)),
      'unrecognized restricted-destination rule is reported',
    );
    assert.ok(
      a.review.unrecognized.some((u) => /per day/.test(u.sentence)),
      'unrecognized per-diem rule is reported',
    );
    const late = evaluateTree(tree, { claim_type: 'expense', days_to_file: 45 }) as { ok: true; output: { decision: string } };
    assert.equal(late.output.decision, 'deny');
    const onTime = evaluateTree(tree, { claim_type: 'expense', days_to_file: 10 }) as {
      ok: true;
      output: { decision: string; reason_code: string };
    };
    assert.equal(
      onTime.output.decision,
      'escalate',
      'an on-time case cannot be approved by a tree that did not understand the payout rules',
    );
    assert.equal(onTime.output.reason_code, 'UNFORMALIZED_RULE');
    assert.ok(a.review.failClosedPaths.includes('expense'));
  });

  it('a document with no decision structure yields no tree at all', () => {
    const a = compile('# Notes\n\n## About (R1)\n\n**Overview.** The office is on the third floor and has a kitchen.');
    assert.equal(a.trees, undefined);
    assert.equal(a.safetyRules, undefined);
  });
});
