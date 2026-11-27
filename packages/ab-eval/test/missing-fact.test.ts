import assert from 'node:assert/strict';
import test from 'node:test';
import { adjudicate, generateMissingFactTasks, MISSING_FACT_CATEGORIES, scoreTask } from '../src/index.js';

for (const style of ['standard', 'variant'] as const) {
  test(`missing-fact set (${style}): every category present, deterministic, expects Claims Manager escalation`, () => {
    const a = generateMissingFactTasks(424242, style, 12);
    const b = generateMissingFactTasks(424242, style, 12);
    assert.deepEqual(
      a.map((t) => t.narrative),
      b.map((t) => t.narrative),
    );
    assert.equal(a.length, MISSING_FACT_CATEGORIES.length * 12);
    for (const cat of MISSING_FACT_CATEGORIES) assert.equal(a.filter((t) => t.stratum === `MISSING_FACT_${cat}`).length, 12);
    for (const t of a) {
      assert.equal(t.expected.decision, 'escalate');
      assert.equal(t.expected.escalation_target, 'Claims Manager');
      assert.notEqual(t.statedFacts, undefined);
    }
  });
}

test('omitted fact really decides the claim: the original (full) claim had a non-escalate or different outcome', () => {
  for (const t of generateMissingFactTasks(1, 'standard', 4)) {
    const full = adjudicate(t.facts);
    assert.notEqual(`${full.decision}|${full.payout_usd}|${full.escalation_target}`, 'escalate|0|Claims Manager');
  }
});

test('approving a missing-fact task is an unsafe auto-approval; escalating is a pass', () => {
  const [t] = generateMissingFactTasks(5, 'variant', 1);
  assert.equal(scoreTask(t!, { decision: 'approve', payout_usd: 100, escalation_target: null }).unsafeAutoApproval, true);
  assert.equal(scoreTask(t!, { decision: 'escalate', payout_usd: 0, escalation_target: 'Claims Manager' }).pass, true);
});

test('train/eval disjoint seeds produce different tasks', () => {
  const a = generateMissingFactTasks(1, 'standard', 3).map((t) => t.narrative);
  const b = generateMissingFactTasks(2, 'standard', 3).map((t) => t.narrative);
  assert.notDeepEqual(a, b);
});
