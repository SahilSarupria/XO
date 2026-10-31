import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGoldXo, generateEvalTasks, scorePackage } from '../src/index.js';

/**
 * Held-out phrasing (style "variant") was written BEFORE it was run through retrieval and retrieval was not tuned
 * against it. Measured on seeds 20260101, 1, 2, 3 at the time of writing: gold recall@9 = 91.9 / 92.1 / 91.7 / 90.6 %
 * (vs 100 % on the standard phrasing). The bounds below are regression guards at that measured level, NOT a target:
 * raising retrieval quality is welcome, but do not tune against these seeds — mint a new seed/style instead.
 */
describe('held-out claim phrasing', () => {
  it('variant tasks describe the same facts with different wording and without the commodity-class header', () => {
    const std = generateEvalTasks(1, 'standard');
    const alt = generateEvalTasks(1, 'variant');
    assert.equal(alt.length, std.length);
    assert.ok(alt.every((t) => !/TMS commodity class/i.test(t.narrative)));
    assert.ok(alt.every((t, i) => t.narrative !== std[i]?.narrative));
    // labels stay true: the oracle's expected outcome and the facts used are recomputed from the facts, never the text
    assert.ok(alt.every((t) => t.expected.decision.length > 0 && t.factsUsed.length > 0));
  });

  it('gold retrieval stays above the measured held-out level on fresh seeds (and is lower than on standard phrasing)', () => {
    const gold = buildGoldXo();
    for (const seed of [1, 2, 3]) {
      const heldOut = scorePackage(gold, generateEvalTasks(seed, 'variant')).recallAtK;
      const standard = scorePackage(gold, generateEvalTasks(seed, 'standard')).recallAtK;
      assert.ok(heldOut >= 0.88, `seed ${seed}: held-out recall ${(heldOut * 100).toFixed(1)}% fell below the 88% guard`);
      assert.ok(heldOut <= standard, `seed ${seed}: held-out recall should not exceed the phrasing it was authored on`);
    }
  });

  it('standard phrasing is unchanged by adding the style option', () => {
    const a = generateEvalTasks();
    const b = generateEvalTasks(20260101, 'standard');
    assert.deepEqual(
      a.map((t) => t.narrative),
      b.map((t) => t.narrative),
    );
    assert.equal(a.length, 50);
  });
});
