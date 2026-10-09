import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVALUATION_VERSION,
  PRODUCER_METRIC_IDS,
  PROVENANCE_METRIC_IDS,
  CROSS_PATH_METRIC_IDS,
  attributeCase,
  buildReport,
  canonicalJson,
  compareReports,
  describeConfiguration,
  describeProducers,
  evaluateCase,
  formatReport,
  loadSuiteFile,
  observeCase,
  parseReport,
  runSuite,
  validateSuiteDefinition,
  type BenchmarkCaseDefinition,
  type BenchmarkReport,
  type CaseEvaluation,
} from '../src/index.js';
import { caseDef, cap, node, observation } from './helpers.js';

/**
 * P0.9C Step 1 — configuration attribution. Attribution is descriptive
 * context: it must be deterministic, derived only from the definition and
 * from what the real pipeline reported, and it must NEVER influence a
 * metric, an item outcome, a fingerprint, or a baseline comparison.
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SYNTHETIC = 'examples/vertical-test/synthetic-claim-rules.txt';
const STRUCTURED = 'examples/vertical-test/structured-operation-data-flow.json';
const AASTHA = 'examples/vertical-test/Aastha.pdf';
const MECHANICS_XOIR = 'packages/benchmark/fixtures/xoir/runtime-mechanics.xoir.json';

function def(over: Partial<BenchmarkCaseDefinition>): BenchmarkCaseDefinition {
  return { caseId: 'c', sources: [{ kind: 'document', path: 'a.txt' }], expect: {}, ...over };
}

// ---- 1. deterministic serialization ----------------------------------------------------------

test('attribution serializes deterministically: independent of node order, and byte-identical across two real runs', async () => {
  const nodes = [node('n1', 'concept', {}), node('n2', 'capability', {}), node('n3', 'capability', {})].map((n, i) => (i === 1 ? { ...n, producedBy: 'rule-based' } : n));
  const a = attributeCase(def({}), { nodes, sourceReports: [] });
  const b = attributeCase(def({}), { nodes: [...nodes].reverse(), sourceReports: [] });
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'plain serialization (not only canonical) is key-order stable');

  const runOnce = async (): Promise<string> => JSON.stringify((await observeAndEvaluate({ caseId: 'det', sources: [{ kind: 'document', path: SYNTHETIC }], expect: {} })).attribution);
  assert.equal(await runOnce(), await runOnce());
});

test('the configuration id covers only the INPUT side: same case => same id; a different declared input => a different id; observed results never move it', () => {
  const base = describeConfiguration(def({}));
  assert.equal(attributeCase(def({}), { nodes: [] }).configurationId, attributeCase(def({}), { nodes: [node('x', 'concept', {})], sourceReports: [{ sourceType: 'document', path: 'a.txt', qualityState: 'degraded', semanticExtractionAvailable: true }] }).configurationId, 'observed producers / quality do not change the id');
  assert.match(attributeCase(def({}), { nodes: [] }).configurationId, /^cfg_[0-9a-f]{16}$/);
  const ids = new Set([
    attributeCase(def({}), { nodes: [] }).configurationId,
    attributeCase(def({ sources: [{ kind: 'html', path: 'a.txt' }] }), { nodes: [] }).configurationId,
    attributeCase(def({ sources: [{ kind: 'document', path: 'b.txt' }] }), { nodes: [] }).configurationId,
    attributeCase(def({ domainHint: 'insurance' }), { nodes: [] }).configurationId,
    attributeCase(def({ execution: [{ kind: 'capability', id: 'e', target: { equals: 'x' } }] }), { nodes: [] }).configurationId,
  ]);
  assert.equal(ids.size, 5);
  assert.equal(base.evaluationVersion, EVALUATION_VERSION);
});

test('the descriptor carries no timestamps, machine paths or environment data', async () => {
  const text = JSON.stringify((await observeAndEvaluate({ caseId: 'clean', sources: [{ kind: 'document', path: SYNTHETIC }], expect: {} })).attribution);
  assert.doesNotMatch(text, /\/home\/|\/tmp\/|C:\\\\|\d{4}-\d{2}-\d{2}T\d{2}:/, 'no absolute paths or ISO timestamps');
  assert.equal(text.includes(REPO_ROOT), false);
});

async function observeAndEvaluate(d: BenchmarkCaseDefinition): Promise<CaseEvaluation> {
  return evaluateCase(d, await observeCase(d, { sourceRoot: REPO_ROOT }));
}

// ---- 2 + 3. source type and source quality (REAL compiler output) -----------------------------

test('source type and qualityState come from what the real compiler reported, per source in input order', async () => {
  const ev = await observeAndEvaluate({
    caseId: 'mixed',
    sources: [
      { kind: 'document', path: SYNTHETIC },
      { kind: 'structured', path: STRUCTURED, format: 'json' },
      { kind: 'pdf', path: AASTHA },
    ],
    expect: {},
  });
  const ctx = ev.attribution!.observedContext;
  assert.deepEqual(ctx.sources.map((s) => [s.sourceType, s.path]), [['document', SYNTHETIC], ['structured', STRUCTURED], ['pdf', AASTHA]]);
  // The compiler assigns a quality state to document-kind sources only (see SourceCompilationReport.qualityState); the benchmark records it as reported and never defaults it.
  const byType = Object.fromEntries(ctx.sources.map((s) => [s.sourceType, s.qualityState]));
  assert.ok(['trusted', 'degraded', 'blocked'].includes(byType['pdf'] as string), `pdf quality is a real compiler state, got ${String(byType['pdf'])}`);
  for (const s of ctx.sources) assert.equal(typeof s.semanticExtractionAvailable, 'boolean');
  assert.equal(ev.attribution!.configuration.sources.length, 3);
  assert.deepEqual(ev.attribution!.configuration.sources.map((s) => s.declaredKind), ['document', 'structured', 'pdf']);
});

test('a source type whose quality pass never runs has NO qualityState (absent, not a defaulted value)', () => {
  const a = attributeCase(def({}), { nodes: [], sourceReports: [{ sourceType: 'openapi', path: 'x.json', semanticExtractionAvailable: true }] });
  assert.equal('qualityState' in a.observedContext.sources[0]!, false);
});

// ---- 4. producer presence / absence -----------------------------------------------------------

test('producer distribution separates attributed from unattributed nodes, per kind, without treating absence as an error', () => {
  const nodes = [
    { ...node('a', 'concept', {}), producedBy: 'rule-based' },
    { ...node('b', 'concept', {}), producedBy: 'rule-based' },
    { ...node('c', 'capability', {}), producedBy: 'structured-operation' },
    node('d', 'capability', {}),
    node('e', 'heuristic', {}),
  ];
  const d = describeProducers({ nodes });
  assert.equal(d.nodeCount, 5);
  assert.deepEqual(d.total, { producers: { 'rule-based': 2, 'structured-operation': 1 }, unattributed: 2 });
  assert.deepEqual(d.byKind['concept'], { producers: { 'rule-based': 2 }, unattributed: 0 });
  assert.deepEqual(d.byKind['capability'], { producers: { 'structured-operation': 1 }, unattributed: 1 });
  assert.deepEqual(d.byKind['heuristic'], { producers: {}, unattributed: 1 });
  // No expectation was involved, and nothing in the evaluation reads absence as a failure.
  const ev = evaluateCase(caseDef({}), observation({ nodes: nodes.map((n) => (n.kind === 'concept' ? { ...n, subtype: 'concept' } : n.kind === 'heuristic' ? { ...n, subtype: 'rule' } : n)) }));
  // (P0.9C Step 4) The DISTRIBUTION above never produces a failure. The Step 4 producer metrics are separate and deliberately measure
  // absence on paths that have a stamping site (here: the un-attributed capability 'd'); the reasoning-derived 'heuristic' is not judged.
  const historical = ev.metrics.filter((m) => !PRODUCER_METRIC_IDS.includes(m.id));
  assert.equal(historical.some((m) => m.missing.length + m.unexpected.length + m.mismatched.length > 0 && /produc/i.test(m.id)), false);
  const coverage = ev.metrics.find((m) => m.id === 'producerAttributionCoverage')!;
  assert.deepEqual([coverage.numerator, coverage.denominator], [3, 4], 'concept a, concept b, capability c attributed; capability d missing; heuristic e not judged');
  assert.deepEqual(coverage.missing.map((i) => i.id), ['capability|d']);
});

test('REAL pipeline: producer presence is observable, and unattributed nodes exist alongside attributed ones (P0.9A design)', async () => {
  const ev = await observeAndEvaluate({ caseId: 'producers', sources: [{ kind: 'document', path: SYNTHETIC }], expect: {} });
  const dist = ev.attribution!.observedContext.producerDistribution;
  assert.ok(Object.keys(dist.total.producers).length > 0, 'at least one real producer name is observable');
  assert.equal(dist.total.unattributed + Object.values(dist.total.producers).reduce((a, b) => a + b, 0), dist.nodeCount, 'every node is counted exactly once');
  // Deliberately NOT asserted: which kinds are attributed. P0.9A leaves some classes unattributed by design.
});

// ---- 5. path attribution ----------------------------------------------------------------------

test('paths record only what the case exercises: requested execution kinds, graph origin, live graph; nothing else', async () => {
  const none = describeConfiguration(def({}));
  assert.deepEqual(none.paths, { host: 'benchmark_observer', graphOrigin: 'compiled_sources', graphForm: 'live_graph', executionPaths: [] });
  const both = describeConfiguration(def({ execution: [{ kind: 'workflow', id: 'w', steps: [{ equals: 'a' }] }, { kind: 'capability', id: 'c', target: { equals: 'a' } }] }));
  assert.deepEqual(both.paths.executionPaths, ['direct_capability', 'workflow']);
  const xo = describeConfiguration({ caseId: 'x', xoir: MECHANICS_XOIR, expect: {} });
  assert.equal(xo.entry, 'xoir');
  assert.equal(xo.paths.graphOrigin, 'serialized_xoir');
  assert.equal(xo.xoir, MECHANICS_XOIR);
  assert.equal('sources' in xo && xo.sources.length, 0);
  // Absent paths stay absent: nothing labels the package / installed path.
  assert.deepEqual(Object.keys(xo.paths).sort(), ['executionPaths', 'graphForm', 'graphOrigin', 'host']);
  assert.equal(xo.paths.graphForm, 'live_graph');
  assert.equal(JSON.stringify(xo.paths).includes('package'), false);
  assert.equal(JSON.stringify(xo.paths).includes('installed'), false);
});

test('REAL serialized-XOIR entry: no compiler ran, so there are no source reports (absent, not empty-labelled)', async () => {
  const d: BenchmarkCaseDefinition = { caseId: 'mech', xoir: MECHANICS_XOIR, expect: {} };
  const obs = await observeCase(d, { sourceRoot: REPO_ROOT });
  assert.equal(obs.sourceReports, undefined);
  const ev = evaluateCase(d, obs);
  assert.deepEqual(ev.attribution!.observedContext.sources, []);
});

test('AI is explicitly recorded as not exercised, and the observer supplies no aiCore', async () => {
  assert.equal(describeConfiguration(def({})).ai, 'not_exercised');
  const src = await readFile(join(PKG, 'src', 'observe.ts'), 'utf8');
  assert.equal(/aiCore\s*[:,}]/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), false, 'observer code passes no aiCore to compileSources');
});

// ---- 6 + 7. backward compatibility; unchanged historical metrics ------------------------------

test('attribution inputs (producedBy, sourceReports) never change any historical metric, item, or fingerprint', () => {
  const d = caseDef({ capabilities: { closedWorld: true, items: [{ id: 'a', name: { equals: 'Alpha' }, resolution: 'resolved' }] } });
  const plain = observation({ nodes: [node('n', 'capability', {})], capabilities: [cap('c1', 'Alpha')] });
  const decorated = {
    ...plain,
    nodes: plain.nodes.map((n) => ({ ...n, producedBy: 'rule-based' })),
    sourceReports: [{ sourceType: 'document', path: 'x.txt', qualityState: 'degraded', semanticExtractionAvailable: true }],
  };
  const a = evaluateCase(d, plain);
  const b = evaluateCase(d, decorated);
  // (P0.9C Step 4) producedBy now feeds exactly two NEW metrics (producer attribution). It must still change no HISTORICAL metric and no item.
  const strip = (e: CaseEvaluation) => { const { attribution: _drop, ...rest } = e; return { ...rest, metrics: rest.metrics.filter((m) => !PRODUCER_METRIC_IDS.includes(m.id)) }; };
  assert.equal(JSON.stringify(strip(b)), JSON.stringify(strip(a)));
  assert.equal(a.metrics.some((m) => m.id === 'producerAttributionCoverage'), true, 'the node is in the stamping population');
  assert.notEqual(JSON.stringify(a.metrics.find((m) => m.id === 'producerAttributionCoverage')), JSON.stringify(b.metrics.find((m) => m.id === 'producerAttributionCoverage')), 'and its producer is what the new metric reads');
});

test('observations built without any attribution inputs (existing callers) still evaluate, with an empty but well-formed attribution', () => {
  const ev = evaluateCase(caseDef({}), observation({}));
  assert.equal(ev.status, 'evaluated');
  assert.deepEqual(ev.attribution!.observedContext.sources, []);
  assert.deepEqual(ev.attribution!.observedContext.producerDistribution, { nodeCount: 0, total: { producers: {}, unattributed: 0 }, byKind: {} });
});

test('a harness_error case is still attributed (the configuration is known even when the run was not possible)', async () => {
  const ev = await observeAndEvaluate({ caseId: 'bad', sources: [{ kind: 'document', path: 'does/not/exist.txt' }], expect: {} });
  assert.equal(ev.status, 'harness_error');
  assert.ok(ev.attribution !== undefined);
  assert.equal(ev.attribution.configuration.sources[0]!.path, 'does/not/exist.txt');
});

test('the 20 historical metric ids keep their committed stage + definition text (checked against the committed baselines)', async () => {
  const HISTORICAL = ['compileOutcomeAccuracy', 'semanticRecall', 'semanticCorrectness', 'semanticPrecision', 'spuriousFactAvoidance', 'provenanceCompleteness', 'observedSourceRefCoverage', 'capabilityRecall', 'capabilityPrecision', 'spuriousCapabilityAvoidance', 'resolutionAccuracy', 'executionClassAccuracy', 'structuredIoAccuracy', 'workflowRecall', 'workflowPrecision', 'workflowExecutabilityAccuracy', 'workflowStructureAccuracy', 'dataFlowCorrectness', 'executionCorrectness', 'runtimeDataFlowTransfer'];
  assert.equal(HISTORICAL.length, 20);
  const seen = new Set<string>();
  for (const name of ['vertical-fixtures', 'runtime-mechanics']) {
    const loaded = await loadSuiteFile(join(PKG, 'suites', `${name}.suite.json`));
    assert.ok(loaded.ok);
    const current = await runSuite(loaded.suite, { sourceRoot: loaded.sourceRoot });
    const baseline = parseReport(JSON.parse(await readFile(join(PKG, 'baselines', `${name}.report.json`), 'utf8')));
    assert.ok(baseline.ok);
    for (const m of baseline.value.aggregate.metrics) {
      seen.add(m.id);
      const now = current.aggregate.metrics.find((x) => x.id === m.id);
      assert.ok(now !== undefined, `${m.id} still reported`);
      assert.equal(now.definition, m.definition, `${m.id}: definition text unchanged`);
      assert.equal(now.stage, m.stage, `${m.id}: stage unchanged`);
    }
    // No attribution field is a metric: the metric id set only ever contains historical ids.
    // Steps 4-6 add exactly five metrics (producer attribution, provenance chain / execution agreement, cross-path consistency); nothing else may appear.
    for (const m of current.aggregate.metrics) assert.ok(HISTORICAL.includes(m.id) || PRODUCER_METRIC_IDS.includes(m.id) || PROVENANCE_METRIC_IDS.includes(m.id) || CROSS_PATH_METRIC_IDS.includes(m.id), `unexpected new metric ${m.id}`);
  }
  for (const id of HISTORICAL.filter((h) => h !== 'runtimeDataFlowTransfer')) assert.ok(seen.has(id), id);
});

// ---- 8. unchanged baseline comparison semantics ------------------------------------------------

function reportFromCases(cases: CaseEvaluation[]): BenchmarkReport {
  return buildReport('s', cases);
}

/** sha256 of the runtime-mechanics baseline exactly as committed BEFORE P0.9C Step 1 (no attribution fields). The historical content is pinned by hash, so the baseline can carry attribution without losing the proof that nothing else moved. */
const PRE_ATTRIBUTION_RUNTIME_MECHANICS_SHA256 = '69822f68d842f9a500c8a39ae3b3e9e04a24596ff2685a232dbbb9c7374f0d0f';

function withoutAttribution(report: BenchmarkReport): Record<string, unknown> {
  const stripped = { ...report, cases: report.cases.map(({ attribution: _a, ...rest }) => rest) } as Record<string, unknown>;
  delete stripped['evaluationVersion'];
  return stripped;
}

test('a baseline in the pre-attribution format compares cleanly against a current report that carries attribution (no verdict change, no configuration warning; the only finding is that the baseline predates evaluation versioning)', async () => {
  const loaded = await loadSuiteFile(join(PKG, 'suites', 'runtime-mechanics.suite.json'));
  assert.ok(loaded.ok);
  const current = await runSuite(loaded.suite, { sourceRoot: loaded.sourceRoot });
  const legacy = parseReport(withoutAttribution(current));
  assert.ok(legacy.ok);
  assert.equal(legacy.value.cases[0]!.attribution, undefined, 'simulated legacy baseline carries no attribution');
  const cmp = compareReports(legacy.value, current);
  assert.equal(cmp.classification, 'no_change');
  // (P0.9C Step 7) a baseline with no evaluationVersion is explicitly reported as predating versioning — and nothing else.
  assert.deepEqual(cmp.warnings.map((w) => w.kind), ['evaluation_version_changed']);
  assert.equal(cmp.regressions.length + cmp.improvements.length + cmp.tradeoffs.length, 0);
  assert.equal(cmp.compilationOutputChanged || cmp.executionOutputChanged, false, 'stage fingerprints are untouched by attribution');
});

test('the accepted runtime-mechanics baseline equals the current output byte-for-byte; the retained predecessor, stripped of attribution, still reproduces the pre-P0.9C baseline (by pinned hash)', async () => {
  const loaded = await loadSuiteFile(join(PKG, 'suites', 'runtime-mechanics.suite.json'));
  assert.ok(loaded.ok);
  const current = await runSuite(loaded.suite, { sourceRoot: loaded.sourceRoot });
  const committed = await readFile(join(PKG, 'baselines', 'runtime-mechanics.report.json'), 'utf8');
  // (P0.9C final closure) the accepted baseline was refreshed jointly with vertical-fixtures; it is now exactly the current output, Step 5 metrics included.
  assert.equal(committed, JSON.stringify(current, null, 2) + '\n', 'accepted baseline is exactly the current output');
  // the historical predecessor is retained unchanged under baselines/archive/ and still pins every pre-P0.9C byte
  const archived = (await readdir(join(PKG, 'baselines', 'archive'))).find((f) => f.startsWith('runtime-mechanics.p0.9c-1.'));
  assert.ok(archived !== undefined, 'the runtime-mechanics predecessor is retained');
  const predecessor = JSON.parse(await readFile(join(PKG, 'baselines', 'archive', archived), 'utf8')) as never;
  const historical = JSON.stringify(withoutAttribution(predecessor), null, 2) + '\n';
  assert.equal(createHash('sha256').update(historical).digest('hex'), PRE_ATTRIBUTION_RUNTIME_MECHANICS_SHA256);
});

test('a configuration change between two attributed reports is a WARNING only: the classification and every verdict are unchanged', () => {
  const mk = (over: Partial<BenchmarkCaseDefinition>): CaseEvaluation => evaluateCase({ ...caseDef({}), ...over }, observation({}));
  const before = reportFromCases([mk({})]);
  const after = reportFromCases([mk({ domainHint: 'insurance' })]);
  const cmp = compareReports(before, after);
  assert.equal(cmp.classification, 'no_change');
  assert.equal(cmp.warnings.filter((w) => w.kind === 'configuration_changed').length, 1);
  const same = compareReports(before, reportFromCases([mk({})]));
  assert.equal(same.warnings.length, 0);
});

test('the report records the evaluation version, and the text rendering shows the configuration per case', async () => {
  const validated = validateSuiteDefinition({ schemaVersion: 1, suiteId: 'fmt', cases: [{ caseId: 'fmt-case', sources: [{ kind: 'document', path: SYNTHETIC }], expect: {} }] });
  assert.ok(validated.ok);
  const report = await runSuite(validated.value, { sourceRoot: REPO_ROOT });
  assert.equal(report.evaluationVersion, EVALUATION_VERSION);
  const text = formatReport(report);
  assert.match(text, /config cfg_[0-9a-f]{16} entry=sources sources=\[document/);
  assert.match(text, /ai=not_exercised/);
});
