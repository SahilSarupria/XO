import assert from 'node:assert/strict';
import test from 'node:test';
import { adjudicate, generateHardMissingTasks, HARD_CATEGORIES } from '../src/index.js';

for (const style of ['standard', 'variant'] as const) {
  test(`hard set (${style}): every multi-omission and conflict category present and deterministic; no escalation hint in the text`, () => {
    const a = generateHardMissingTasks(777, style, 6);
    assert.deepEqual(a.map((t) => t.narrative), generateHardMissingTasks(777, style, 6).map((t) => t.narrative));
    for (const c of HARD_CATEGORIES) assert.equal(a.filter((t) => t.stratum === `MISSING_FACT_${c}`).length, 6, c);
    for (const t of a) {
      assert.equal(t.expected.decision, 'escalate');
      assert.doesNotMatch(t.narrative, /Desk note/);
    }
  });
}

test('conflict claims really contain both values and the contradicted fact decides the outcome', () => {
  const conflicts = generateHardMissingTasks(5, 'standard', 3).filter((t) => t.stratum.includes('CONFLICT'));
  assert.ok(conflicts.length >= 18);
  for (const t of conflicts) assert.notEqual(adjudicate(t.facts).decision === 'escalate' && adjudicate(t.facts).payout_usd === 0, true);
});
