import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports, formatRegression, loadSuiteFile, parseReport, runSuite, type BenchmarkReport } from '../src/index.js';

/**
 * The committed suites are run against the REAL pipeline and compared to
 * the committed baseline reports (`baselines/*.report.json`, written by
 * `xo benchmark-run ... --out`). A pipeline change that makes any metric
 * worse, loses a measurement, or drops a case FAILS here with the
 * regression report; a change that only improves things (or leaves
 * observable output identical) passes — refresh the baseline
 * deliberately with:
 *
 *   xo benchmark-run packages/benchmark/suites/<suite>.suite.json --out packages/benchmark/baselines/<suite>.report.json
 *
 * The baseline records the pipeline's ACTUAL results against ground truth
 * that was authored independently of it, INCLUDING its known gaps
 * (see the suite descriptions) — a baseline is a regression reference,
 * not a claim that the gaps do not exist.
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));

async function run(name: string): Promise<{ current: BenchmarkReport; baseline: BenchmarkReport }> {
  const loaded = await loadSuiteFile(join(PKG, 'suites', `${name}.suite.json`));
  assert.ok(loaded.ok, loaded.ok ? '' : `${loaded.message}\n${loaded.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}`);
  const current = await runSuite(loaded.suite, { sourceRoot: loaded.sourceRoot });
  const parsed = parseReport(JSON.parse(await readFile(join(PKG, 'baselines', `${name}.report.json`), 'utf8')));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.message);
  return { current, baseline: parsed.value };
}

const metric = (r: BenchmarkReport, id: string) => r.aggregate.metrics.find((m) => m.id === id)!;

test('runtime-mechanics (hand-built XOIR through contracts / workflows / runtime): no regression vs baseline, and every measured dimension is currently exact', async () => {
  const { current, baseline } = await run('runtime-mechanics');
  const cmp = compareReports(baseline, current);
  assert.ok(cmp.classification === 'no_change' || cmp.classification === 'improved', formatRegression(cmp));
  assert.equal(current.harnessErrorCount, 0);
  assert.equal(current.measured, true);
  for (const m of current.aggregate.metrics) assert.equal(m.ratio, 1, `${m.id}: ${m.numerator}/${m.denominator} ${JSON.stringify([...m.missing, ...m.unexpected, ...m.mismatched])}`);
  // Not vacuous: the suite really exercises each dimension.
  for (const [id, min] of [['capabilityRecall', 8], ['workflowRecall', 4], ['dataFlowCorrectness', 1], ['executionCorrectness', 9], ['runtimeDataFlowTransfer', 2], ['workflowExecutabilityAccuracy', 4]] as const) {
    assert.ok(metric(current, id).denominator >= min, `${id} denominator ${metric(current, id).denominator} < ${min}`);
  }
  assert.deepEqual(current.cases[0]!.observed.workflows.byExecutability, { executable_candidate: 2, not_executable_yet: 1, semantically_invalid: 1 });
});

test('vertical-fixtures (real sources through the whole pipeline): no regression vs baseline; every case ran; compile, contract, workflow and runtime stages all completed', async () => {
  const { current, baseline } = await run('vertical-fixtures');
  const cmp = compareReports(baseline, current);
  assert.ok(cmp.classification === 'no_change' || cmp.classification === 'improved', formatRegression(cmp));
  if (cmp.compilationOutputChanged || cmp.executionOutputChanged) {
    // eslint-disable-next-line no-console
    console.log(`# note: observable pipeline output drifted from the baseline without a metric regression (compile-side ${cmp.compilationOutputChanged}, execution ${cmp.executionOutputChanged}) — consider refreshing the baseline`);
  }
  assert.equal(current.caseCount, 7);
  assert.equal(current.harnessErrorCount, 0);
  for (const c of current.cases) for (const s of Object.values(c.stages)) assert.notEqual(s.status, 'failed', `${c.caseId}/${s.stage}: ${s.errorMessage}`);
  // Not vacuous: real breadth is measured.
  for (const [id, min] of [['semanticRecall', 30], ['semanticPrecision', 20], ['capabilityRecall', 40], ['executionCorrectness', 25], ['provenanceCompleteness', 50], ['workflowRecall', 8]] as const) {
    assert.ok(metric(current, id).denominator >= min, `${id} denominator ${metric(current, id).denominator} < ${min}`);
  }
});

test('the vertical suite reports the pipeline\'s real failure MODES separately (no blended score): semantic false positives, incorrect parses, missing capabilities and class gaps are distinct, individually attributable numbers', async () => {
  const { current } = await run('vertical-fixtures');
  // Present today (see baseline): these are measured, named, and separately reported — improving one must not be able to hide another.
  const ids = new Set(current.aggregate.metrics.map((m) => m.id));
  for (const id of ['semanticRecall', 'semanticCorrectness', 'semanticPrecision', 'spuriousFactAvoidance', 'capabilityRecall', 'capabilityPrecision', 'spuriousCapabilityAvoidance', 'executionClassAccuracy', 'resolutionAccuracy', 'workflowRecall', 'workflowExecutabilityAccuracy', 'dataFlowCorrectness', 'provenanceCompleteness', 'executionCorrectness']) assert.ok(ids.has(id as never), id);
  assert.equal(ids.has('score' as never), false);
  // Execution gaps that originate upstream are attributed upstream, not to the runtime — any compile-side
  // stage (compile/capabilities/workflows, per compare.ts's COMPILE_SIDE) counts as "upstream"; 'execution'
  // itself would mean the runtime was blamed for a gap it didn't cause. wf-partner-payouts-escalates
  // (see CHANGELOG.md's Layer 0 residual gap) is a workflow-kind execution assertion whose target workflow
  // can't be composed due to an upstream capability-naming defect — evaluate.ts correctly attributes that to
  // 'workflows' (the stage that couldn't resolve the target), not 'capabilities' (which this assertion
  // originally, and too narrowly, hardcoded as the only acceptable upstream stage).
  const execFailures = current.cases.flatMap((c) => c.items.filter((i) => i.dimension === 'execution' && i.outcome !== 'passed'));
  const upstreamStages = new Set(['compile', 'capabilities', 'workflows']);
  for (const f of execFailures) assert.ok(upstreamStages.has(f.attributedStage as string), `${f.id}: attributed to '${f.attributedStage}', detail: ${f.detail}`);
  // The honest distributions of what the pipeline produced are always present, expectations or not.
  assert.ok(current.aggregate.observed.capabilities.byResolution['unresolved']! > 0);
  assert.ok(current.aggregate.observed.workflows.byExecutability['not_executable_yet']! > 0);
  assert.ok(current.aggregate.observed.workflows.byExecutability['semantically_invalid']! > 0);
});

test('running a suite twice yields byte-identical reports (deterministic: no timestamps, no unordered iteration)', async () => {
  const { current } = await run('runtime-mechanics');
  const again = await run('runtime-mechanics');
  assert.equal(JSON.stringify(again.current), JSON.stringify(current));
  const v1 = await run('vertical-fixtures');
  const v2 = await run('vertical-fixtures');
  assert.equal(JSON.stringify(v2.current), JSON.stringify(v1.current));
});

test('case order in the definition never changes the report (cases are independent and reported sorted by id)', async () => {
  const loaded = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(loaded.ok);
  const reversed = { ...loaded.suite, cases: [...loaded.suite.cases].reverse() };
  const a = await runSuite(loaded.suite, { sourceRoot: loaded.sourceRoot });
  const b = await runSuite(reversed, { sourceRoot: loaded.sourceRoot });
  assert.equal(JSON.stringify(b), JSON.stringify(a));
});
