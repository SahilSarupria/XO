import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildArms,
  buildGoldXo,
  buildReport,
  costPerCorrect,
  generateEvalTasks,
  renderComparison,
  renderMarkdown,
  runEval,
  SimulatedModel,
} from '../src/index.js';

test('cost per task and per correct task follow the stated prices (self-test, plumbing only)', async () => {
  const tasks = generateEvalTasks().slice(0, 6);
  const sim = new SimulatedModel(tasks);
  const arms = buildArms({ provider: sim, model: 'sim-1', gold: buildGoldXo() });
  const records = await runEval({ arms: [arms.plain, arms.xo_tools], tasks, concurrency: 2 });
  const rep = buildReport(
    records,
    { model: 'sim-1', provider: sim.id, date: 'd', trials: 1, selfTest: true },
    { inputPerMTok: 1, outputPerMTok: 4 },
  );
  for (const a of rep.arms) {
    const expected = (a.meanInputTokens * 1 + a.meanOutputTokens * 4) / 1e6;
    assert.ok(Math.abs((a.estimatedCostUsd ?? NaN) - expected) < 1e-12);
    if (a.passRate > 0) assert.equal(costPerCorrect(a), (expected / a.passRate).toFixed(5));
    else assert.equal(costPerCorrect(a), '—');
  }
  assert.match(renderMarkdown(rep), /est\. cost \/ correct task/);
  const unpriced = buildReport(records, { model: 'sim-1', provider: sim.id, date: 'd', trials: 1, selfTest: true });
  assert.equal(costPerCorrect(unpriced.arms[0]!), '—');
  const cmp = renderComparison([
    { label: 'modelA', report: rep },
    { label: 'modelB', report: rep },
  ]);
  assert.match(cmp, /modelA pass/);
  assert.match(cmp, /modelB tokens/);
});
