import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, compareReports, evaluateCase, formatRegression, runSuite, validateSuiteDefinition, type BenchmarkCaseDefinition, type BenchmarkReport, type PipelineObservation } from '../src/index.js';
import { cap, capRun, caseDef, node, observation, wf } from './helpers.js';

const rule = (id: string, q: string) => node(id, 'decision_node', { question: q, outcome: 'x' }, { pages: [1] });
const fact = (id: string, q: string) => ({ id, kind: 'decision_node', identify: [{ path: 'question', contains: q }] });

function report(defs: readonly BenchmarkCaseDefinition[], obs: readonly PipelineObservation[], suiteId = 's'): BenchmarkReport {
  return buildReport(suiteId, defs.map((d, i) => evaluateCase(d, obs[i]!)));
}
const finding = (r: ReturnType<typeof compareReports>, metricId: string) => r.regressions.find((f) => f.metricId === metricId);

test('identical runs compare as no_change, with no findings and unchanged stage outputs', () => {
  const d = caseDef({ semantics: { facts: [fact('a', 'alpha')] }, capabilities: { items: [{ id: 'k', name: { equals: 'K' } }] } });
  const o = observation({ nodes: [rule('n1', 'alpha')], capabilities: [cap('c1', 'K')] });
  const r = compareReports(report([d], [o]), report([d], [o]));
  assert.equal(r.classification, 'no_change');
  assert.deepEqual([r.compilationOutputChanged, r.executionOutputChanged, r.executionOnlyRegression], [false, false, false]);
  assert.deepEqual([r.regressions, r.improvements, r.tradeoffs, r.warnings].map((l) => l.length), [0, 0, 0, 0]);
});

test('"improved recall but introduced semantic false positives": reported as a TRADEOFF naming the new unexpected items — never as a plain improvement', () => {
  const d = caseDef({ semantics: { closedWorldKinds: ['decision_node'], facts: [fact('a', 'alpha'), fact('b', 'beta')] } });
  const before = observation({ nodes: [rule('n1', 'alpha')] });
  const after = observation({ nodes: [rule('n1', 'alpha'), rule('n2', 'beta'), rule('n3', 'spurious one'), rule('n4', 'spurious two')] });
  const r = compareReports(report([d], [before]), report([d], [after]));

  const recall = r.aggregate.find((m) => m.metricId === 'semanticRecall')!;
  const precision = r.aggregate.find((m) => m.metricId === 'semanticPrecision')!;
  assert.equal(recall.verdict, 'improved');
  assert.equal(precision.verdict, 'regressed');
  assert.deepEqual(recall.resolved, ['c1|b']);
  assert.deepEqual(precision.newlyFailing, ['c1|decision_node|spurious one', 'c1|decision_node|spurious two']);
  assert.equal(r.tradeoffs.length, 1);
  assert.match(r.tradeoffs[0]!.message, /semanticRecall improved 50\.0% \(1\/2\) -> 100\.0% \(2\/2\) but semanticPrecision regressed 100\.0% \(1\/1\) -> 50\.0% \(2\/4\).*newly failing: c1:decision_node\|spurious one, c1:decision_node\|spurious two/);
  assert.equal(r.classification, 'mixed');
  assert.match(formatRegression(r), /Tradeoffs \(1\)/);
});

test('"a runtime change did not change semantic compilation but broke execution": compile/capability/workflow stage OUTPUTS are identical, an execution metric regressed => execution-only, attributed to `execution`', () => {
  const capExec = { id: 'e1', kind: 'capability' as const, target: { equals: 'K' }, input: {}, expect: { outcome: 'succeeded' as const, output: { matched: true } } };
  const d = caseDef({ semantics: { facts: [fact('a', 'alpha')] }, capabilities: { items: [{ id: 'k', name: { equals: 'K' }, executionClass: 'deterministic_rule' as const }] } }, [capExec]);
  const compileSide = { nodes: [rule('n1', 'alpha')], capabilities: [cap('c1', 'K')] };
  const before = observation({ ...compileSide, executions: [capRun('e1', { output: { matched: true } })] });
  const after = observation({ ...compileSide, executions: [capRun('e1', { outcome: 'error', errorCode: 'XO_RUNTIME_EXECUTION_FAILED', message: 'evaluator threw' })] });
  const r = compareReports(report([d], [before]), report([d], [after]));

  assert.equal(r.compilationOutputChanged, false, 'the semantic compilation output is byte-for-byte the same');
  assert.equal(r.executionOutputChanged, true);
  assert.equal(r.executionOnlyRegression, true);
  assert.equal(r.classification, 'regressed');
  const f = finding(r, 'executionCorrectness')!;
  assert.deepEqual([f.stage, f.attribution, f.caseId], ['execution', 'execution_only', 'c1']);
  assert.deepEqual(r.cases[0]!.stageOutputChanged, { compile: false, capabilities: false, workflows: false, execution: true });
  assert.equal(r.regressions.filter((x) => x.attribution === 'compilation').length, 0, 'no compile-side metric moved');
});

test('a COMPILE-side regression is attributed to compilation, and the execution failures it causes are attributed as downstream — not blamed on the runtime', () => {
  const capExec = { id: 'e1', kind: 'capability' as const, target: { equals: 'K' }, input: {}, expect: { outcome: 'succeeded' as const } };
  const d = caseDef({ capabilities: { items: [{ id: 'k', name: { equals: 'K' } }] } }, [capExec]);
  const before = observation({ capabilities: [cap('c1', 'K')], executions: [capRun('e1', { output: {} })] });
  const after = observation({ capabilities: [], executions: [capRun('e1', { outcome: 'target_not_found' })] });
  const r = compareReports(report([d], [before]), report([d], [after]));
  assert.equal(r.compilationOutputChanged, true);
  assert.equal(r.executionOnlyRegression, false);
  assert.equal(finding(r, 'capabilityRecall')!.attribution, 'compilation');
  assert.equal(finding(r, 'executionCorrectness')!.attribution, 'downstream_of_compilation_change');
});

test('lost coverage: when an upstream item vanishes, a downstream metric whose denominator shrinks is flagged `coverage_reduced` — a ratio alone would have hidden it', () => {
  const d = caseDef({ workflows: { items: [{ id: 'w', steps: [{ equals: 'A' }, { equals: 'B' }], dataFlow: { bindings: [{ producer: { equals: 'A' }, output: 'o', consumer: { equals: 'B' }, input: 'i', status: 'proven' as const }] } }] } });
  const flow = wf('wf1', [['a', 'A'], ['b', 'B']], { bindings: [{ producerCapabilityId: 'a', producerName: 'A', output: 'o', consumerCapabilityId: 'b', consumerName: 'B', input: 'i', status: 'proven', wired: true }] });
  const before = observation({ capabilities: [cap('a', 'A'), cap('b', 'B')], workflows: [flow] });
  const after = observation({ capabilities: [cap('a', 'A'), cap('b', 'B')], workflows: [] });
  const r = compareReports(report([d], [before]), report([d], [after]));
  assert.equal(finding(r, 'workflowRecall')!.attribution, 'compilation');
  const w = r.warnings.find((x) => x.kind === 'coverage_reduced' && x.metricId === 'dataFlowCorrectness');
  assert.ok(w, 'dataFlowCorrectness lost its only assertion');
  assert.match(w!.message, /now evaluates 0 assertion\(s\), down from 1/);
});

test('item-aware verdicts: fixing one item while breaking another leaves the ratio unchanged but is `mixed`, not `unchanged`', () => {
  const d = caseDef({ semantics: { facts: [fact('a', 'alpha'), fact('b', 'beta')] } });
  const before = observation({ nodes: [rule('n1', 'alpha')] });
  const after = observation({ nodes: [rule('n2', 'beta')] });
  const r = compareReports(report([d], [before]), report([d], [after]));
  const recall = r.aggregate.find((m) => m.metricId === 'semanticRecall')!;
  assert.equal(recall.before!.ratio, recall.after!.ratio);
  assert.equal(recall.verdict, 'mixed');
  assert.deepEqual([recall.newlyFailing, recall.resolved], [['c1|a'], ['c1|b']]);
});

test('improvement only => `improved`', () => {
  const d = caseDef({ semantics: { facts: [fact('a', 'alpha'), fact('b', 'beta')] } });
  const r = compareReports(report([d], [observation({ nodes: [rule('n1', 'alpha')] })]), report([d], [observation({ nodes: [rule('n1', 'alpha'), rule('n2', 'beta')] })]));
  assert.equal(r.classification, 'improved');
  assert.equal(r.regressions.length + r.tradeoffs.length, 0);
});

test('cases added/removed and suite-id mismatches are surfaced: a removed case is a regression (its measurements are gone), an added one a warning', () => {
  const d1 = caseDef({ semantics: { facts: [fact('a', 'alpha')] } }, undefined, 'one');
  const d2 = caseDef({ semantics: { facts: [fact('a', 'alpha')] } }, undefined, 'two');
  const o = observation({ nodes: [rule('n1', 'alpha')] });
  const removed = compareReports(report([d1, d2], [o, o]), report([d1], [o]));
  assert.ok(removed.regressions.some((f) => f.kind === 'case_removed' && f.caseId === 'two'));
  assert.equal(removed.classification, 'regressed');
  const added = compareReports(report([d1], [o]), report([d1, d2], [o, o]));
  assert.ok(added.warnings.some((f) => f.kind === 'case_added' && f.caseId === 'two'));
  const other = compareReports(report([d1], [o], 'a'), report([d1], [o], 'b'));
  assert.ok(other.warnings.some((f) => /different suites/.test(f.message)));
});

test('the comparison is independent of case order in either report', () => {
  const d1 = caseDef({ semantics: { facts: [fact('a', 'alpha')] } }, undefined, 'one');
  const d2 = caseDef({ semantics: { facts: [fact('b', 'beta')] } }, undefined, 'two');
  const o1 = observation({ nodes: [rule('n1', 'alpha')] });
  const o2 = observation({ nodes: [rule('n2', 'beta')] });
  const o2Worse = observation({ nodes: [] });
  const a = compareReports(report([d1, d2], [o1, o2]), report([d1, d2], [o1, o2Worse]));
  const b = compareReports(report([d2, d1], [o2, o1]), report([d2, d1], [o2Worse, o1]));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---------------------------------------------------------------------------
// The same comparison over the REAL pipeline: a change to the pipeline's INPUT graph
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURE = 'packages/benchmark/fixtures/xoir/runtime-mechanics.xoir.json';

test('REAL pipeline regression detection: removing the precedence edge between two steps of the hand-built graph (a "compiler change") is detected across recall, data flow, and execution, attributed to compilation', async () => {
  const suiteRaw = JSON.parse(await readFile(join(REPO_ROOT, 'packages/benchmark/suites/runtime-mechanics.suite.json'), 'utf8')) as unknown;
  const validated = validateSuiteDefinition(suiteRaw);
  assert.ok(validated.ok);

  const dir = await mkdtemp(join(tmpdir(), 'xo-bm-regress-'));
  try {
    const mutatedRoot = join(dir, 'mutated');
    await mkdir(join(mutatedRoot, dirname(FIXTURE)), { recursive: true });
    const graph = JSON.parse(await readFile(join(REPO_ROOT, FIXTURE), 'utf8')) as { edges: { id: string }[] };
    const before = graph.edges.length;
    graph.edges = graph.edges.filter((e) => e.id !== 'edge_cap_bm_flow_b_requires_cap_bm_flow_a');
    assert.equal(graph.edges.length, before - 1);
    await writeFile(join(mutatedRoot, FIXTURE), JSON.stringify(graph));

    const baseline = await runSuite(validated.value, { sourceRoot: REPO_ROOT });
    const current = await runSuite(validated.value, { sourceRoot: mutatedRoot });
    const r = compareReports(baseline, current);

    assert.equal(r.classification, 'regressed');
    assert.equal(r.compilationOutputChanged, true);
    assert.equal(r.executionOnlyRegression, false);
    const ids = new Set(r.regressions.map((f) => f.metricId));
    for (const id of ['workflowRecall', 'executionCorrectness']) assert.ok(ids.has(id as never), `${id} regressed: ${[...ids].join(', ')}`);
    assert.ok(r.warnings.some((w) => w.kind === 'coverage_reduced' && w.metricId === 'dataFlowCorrectness'), 'the proven-binding assertion disappeared with the workflow');
    assert.ok(r.warnings.some((w) => w.kind === 'coverage_reduced' && w.metricId === 'runtimeDataFlowTransfer') || r.regressions.some((f) => f.metricId === 'runtimeDataFlowTransfer'));
    // The workflow-execution failures are attributed to the compile side (the workflow no longer exists), not to the runtime.
    const exec = current.cases[0]!.items.filter((i) => i.dimension === 'execution' && i.outcome !== 'passed');
    assert.ok(exec.length > 0);
    for (const item of exec) assert.notEqual(item.attributedStage, 'execution', `${item.id}: ${item.detail}`);
    // Unchanged cases and stages are recognized as unchanged: nothing else drifted.
    assert.equal(r.aggregate.find((m) => m.metricId === 'capabilityRecall')!.verdict, 'unchanged');
    assert.equal(r.aggregate.find((m) => m.metricId === 'resolutionAccuracy')!.verdict, 'unchanged');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

