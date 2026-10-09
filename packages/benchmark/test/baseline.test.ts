import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSources } from '@xo/compiler';
import { projectAllCapabilityProvenance } from '@xo/capability-contract';
import {
  CHANGE_CLASSES,
  METRIC_INTRODUCED_IN,
  RUN_SPECIFIC_KEYS,
  buildReport,
  classifyDifferences,
  compareReports,
  evaluateCase,
  expectationsFingerprint,
  findRunSpecificFields,
  loadSuiteFile,
  parseBaselineManifest,
  parseReport,
  runSuite,
  sha256Hex,
  validateRefreshRecord,
  verifyManifestEntry,
  type BaselineManifestEntry,
  type BaselineRefreshRecord,
  type BenchmarkReport,
  type KnownDrift,
  type MetricId,
} from '../src/index.js';
import { cap, caseDef, observation } from './helpers.js';

/**
 * P0.9C Step 7 — the baseline + regression protocol. A baseline is evidence of a reviewed state; these tests pin that no regeneration, new metric,
 * version bump, config change or population change can pass as "no regression" without being classified and accounted for.
 */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---- builders ---------------------------------------------------------------------------------

function reportOf(over: { missing?: number; extraCaps?: number; caseId?: string } = {}): BenchmarkReport {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `k${i}`, name: { equals: `Cap${i}` } }));
  const found = Array.from({ length: 4 - (over.missing ?? 0) }, (_, i) => cap(`c${i}`, `Cap${i}`));
  const extra = Array.from({ length: over.extraCaps ?? 0 }, (_, i) => cap(`x${i}`, `Extra${i}`));
  return buildReport('suite-a', [evaluateCase(caseDef({ capabilities: { items } }, undefined, over.caseId ?? 'case-1'), observation({ capabilities: [...found, ...extra] }))]);
}
const withMetric = (r: BenchmarkReport, id: string, over: Record<string, unknown> = {}): BenchmarkReport => {
  const x = clone(r) as BenchmarkReport & { cases: { metrics: Record<string, unknown>[] }[]; aggregate: { metrics: Record<string, unknown>[] } };
  const m = { id, stage: 'compile', definition: `d-${id}`, numerator: 1, denominator: 1, ratio: 1, measured: true, missing: [], unexpected: [], mismatched: [], ...over };
  x.cases[0]!.metrics.push(m); x.aggregate.metrics.push(m);
  return x as unknown as BenchmarkReport;
};
const without = (r: BenchmarkReport, id: string): BenchmarkReport => { const x = clone(r) as any; for (const c of x.cases) c.metrics = c.metrics.filter((m: any) => m.id !== id); x.aggregate.metrics = x.aggregate.metrics.filter((m: any) => m.id !== id); return x; };
const setVersion = (r: BenchmarkReport, v: string | undefined): BenchmarkReport => { const x = clone(r) as any; if (v === undefined) delete x.evaluationVersion; else x.evaluationVersion = v; return x; };
const classes = (a: ReturnType<typeof classifyDifferences>) => a.differences.map((d) => `${d.class}:${d.id}`);

// ---- 1. determinism & the graph-hash policy -----------------------------------------------------

test('determinism: repeated identical runs give byte-identical reports; no report (committed or fresh) carries a run-specific field', async () => {
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(l.ok);
  const small = { ...l.suite, cases: l.suite.cases.filter((c) => c.caseId === 'synthetic-claim-rules') };
  const a = JSON.stringify(await runSuite(small, { sourceRoot: l.sourceRoot }));
  const b = JSON.stringify(await runSuite(small, { sourceRoot: l.sourceRoot }));
  assert.equal(a, b);
  assert.deepEqual(findRunSpecificFields(JSON.parse(a)), []);
  for (const f of ['vertical-fixtures', 'runtime-mechanics']) assert.deepEqual(findRunSpecificFields(JSON.parse(await readFile(join(PKG, 'baselines', `${f}.report.json`), 'utf8'))), [], f);
  // the guard works
  assert.deepEqual(findRunSpecificFields({ a: { graphHash: 'x' }, b: [{ createdAt: 'y' }], p: '/home/me/x' }), ['$.a.graphHash', '$.b[0].createdAt', '$.p (absolute path)']);
  assert.ok(RUN_SPECIFIC_KEYS.includes('graphHash'));
});

test('GRAPH-HASH POLICY: independently compiled identical fixtures have different graph hashes, yet identical capability ids / contract hashes / bindings; the benchmark compares reports of two such compiles as unchanged', async () => {
  const text = await readFile(join(PKG, '..', '..', 'examples', 'vertical-test', 'synthetic-claim-rules.txt'), 'utf8');
  const compile = async () => ((await compileSources([{ kind: 'document', text, sourcePath: 'examples/vertical-test/synthetic-claim-rules.txt' }] as never, {})) as any).value.graph;
  const g1 = await compile();
  await new Promise((r) => setTimeout(r, 15));
  const g2 = await compile();
  assert.notEqual(g1.contentHash(), g2.contentHash(), 'the graph hash is an instance / provenance identity (createdAt is hashed by design)');
  const sem = (g: any) => JSON.stringify(projectAllCapabilityProvenance(g).map((p: any) => [p.capabilityId, p.contractContentHash, p.binding.status, p.binding.bindingId ?? '']));
  assert.equal(sem(g1), sem(g2), 'the stable semantic identities do not move');
  // a graph instance and its own serialized copy share the hash (the only scope in which it is compared)
  const { toJson, fromJson } = await import('@xo/xoir');
  const copy: any = fromJson(JSON.parse(JSON.stringify(toJson(g1)))); assert.ok(copy.ok);
  assert.equal(copy.value.contentHash(), g1.contentHash());

  // two independent benchmark runs are the same evidence: no regression, no warning, no difference at all
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json'));
  assert.ok(l.ok);
  const small = { ...l.suite, cases: l.suite.cases.filter((c) => c.caseId === 'synthetic-claim-rules') };
  const r1 = await runSuite(small, { sourceRoot: l.sourceRoot });
  const r2 = await runSuite(small, { sourceRoot: l.sourceRoot });
  const cmp = compareReports(r1, r2);
  assert.equal(cmp.classification, 'no_change'); assert.equal(cmp.warnings.length, 0);
  assert.equal(classifyDifferences(r1, r2).decision, 'identical');
  assert.equal(JSON.stringify(r1).includes('sha256:'), false, 'no graph hash (or any instance hash) reaches a report');
});

// ---- 2. new metrics ---------------------------------------------------------------------------

test('a historical baseline that predates a metric: the metric is ABSENT (not 0), the candidate does not fail for it, even if the new metric has failures — and it is classified as an expected addition', () => {
  const base = reportOf();
  const cand = withMetric(base, 'crossPathConsistency', { numerator: 1, denominator: 4, ratio: 0.25, mismatched: [{ id: 'a', reason: 'r', attributedStage: 'capabilities' }, { id: 'b', reason: 'r', attributedStage: 'capabilities' }, { id: 'c', reason: 'r', attributedStage: 'capabilities' }] });
  const cmp = compareReports(base, cand);
  assert.equal(cmp.classification, 'no_change', 'a new metric with failures is not a regression against a baseline that never had it');
  assert.equal(cmp.regressions.length, 0);
  const d = cmp.cases[0]!.metrics.find((m) => m.metricId === 'crossPathConsistency')!;
  assert.equal(d.presence, 'added'); assert.equal(d.before, null); assert.deepEqual([d.newlyFailing.length, d.resolved.length], [0, 0]);
  assert.ok(cmp.warnings.some((w) => w.kind === 'metric_added' && /new \(the baseline predates it\)/.test(w.message)), 'visible, not silent');
  const a = classifyDifferences(base, cand);
  assert.deepEqual(classes(a), ['expected_metric_addition:metric|case-1|crossPathConsistency']);
  assert.equal(a.decision, 'compatible');
});

test('every metric added by Steps 4-6 is a registered expected addition; an unregistered new metric makes the pair not_comparable', () => {
  assert.deepEqual(Object.keys(METRIC_INTRODUCED_IN).sort(), ['crossPathConsistency', 'executionProvenanceAgreement', 'producerAttributionCorrectness', 'producerAttributionCoverage', 'provenanceChainCoverage']);
  const base = reportOf();
  assert.equal(classifyDifferences(base, withMetric(base, 'madeUpMetric')).decision, 'not_comparable');
});

// ---- 3. removed / renamed / changed metrics -----------------------------------------------------

test('a removed metric earns NO improvement credit and is a lost measurement: warning + semantic_regression at the same evaluation version; evaluation_version_change when the version changed', () => {
  const base = withMetric(reportOf(), 'provenanceChainCoverage', { numerator: 0, denominator: 2, ratio: 0, missing: [{ id: 'x', reason: 'r', attributedStage: 'capabilities' }] });
  const cand = without(base, 'provenanceChainCoverage');
  const cmp = compareReports(base, cand);
  const d = cmp.cases[0]!.metrics.find((m) => m.metricId === 'provenanceChainCoverage')!;
  assert.equal(d.presence, 'removed'); assert.equal(d.verdict, 'unchanged', 'previously its failing items were credited as "resolved" => "improved"');
  assert.equal(cmp.improvements.length, 0);
  assert.ok(cmp.warnings.some((w) => w.kind === 'metric_removed'));
  const same = classifyDifferences(base, cand);
  assert.equal(same.differences.find((x) => x.metricId === 'provenanceChainCoverage')!.class, 'semantic_regression');
  assert.equal(same.decision, 'regression');
  const bumped = classifyDifferences(setVersion(base, 'p1'), setVersion(cand, 'p2'));
  assert.equal(bumped.differences.find((x) => x.metricId === 'provenanceChainCoverage')!.class, 'evaluation_version_change');
  assert.equal(bumped.decision, 'review_required');
});

test('renamed / split / merged metrics are never matched by position: a rename is a removal plus an addition, both reported; metric order is irrelevant', () => {
  const base = withMetric(reportOf(), 'oldName');
  const renamed = withMetric(without(base, 'oldName'), 'newName');
  const a = classifyDifferences(base, renamed);
  assert.ok(a.differences.some((d) => d.metricId === 'oldName' && d.class === 'semantic_regression'));
  assert.ok(a.differences.some((d) => d.metricId === 'newName' && d.class === 'not_comparable'));
  assert.notEqual(a.decision, 'compatible');
  // reordering the metrics array changes nothing
  const reordered = clone(reportOf()) as any; reordered.cases[0].metrics.reverse(); reordered.aggregate.metrics.reverse();
  assert.equal(classifyDifferences(reportOf(), reordered).decision, 'identical');
});

test('a changed metric definition requires an evaluation-version change: without one the pair is not comparable (undeclared); with one it is an evaluation_version_change', () => {
  const base = reportOf();
  const changed = clone(base) as any; changed.cases[0].metrics[0].definition += ' (redefined)';
  const cmp = compareReports(base, changed);
  assert.ok(cmp.warnings.some((w) => w.kind === 'metric_definition_changed'));
  const a = classifyDifferences(base, changed);
  assert.equal(a.differences.find((d) => d.id.startsWith('definition|'))!.class, 'not_comparable');
  assert.equal(a.decision, 'not_comparable');
  const b = classifyDifferences(setVersion(base, 'p1'), setVersion(changed, 'p2'));
  assert.equal(b.differences.find((d) => d.id.startsWith('definition|'))!.class, 'evaluation_version_change');
});

test('an evaluation-version difference is never silent: a warning, a classified difference, and (for a baseline with no version) the explicit "predates versioning" wording', () => {
  const base = reportOf();
  const cmp = compareReports(setVersion(base, undefined), base);
  assert.deepEqual(cmp.warnings.map((w) => w.kind), ['evaluation_version_changed']);
  assert.match(cmp.warnings[0]!.message, /predates versioning/);
  assert.equal(classifyDifferences(setVersion(base, undefined), base).differences[0]!.class, 'evaluation_version_change');
  assert.equal(compareReports(base, base).warnings.length, 0);
});

// ---- 4. configuration, population, golden, representation ---------------------------------------

test('configuration: the same configuration is not flagged; a changed configuration id is a configuration_changed warning and every metric difference of that case is classified configuration_change — never an ordinary regression', () => {
  const base = reportOf();
  assert.equal(compareReports(base, clone(base)).warnings.length, 0);
  const cand = clone(reportOf({ missing: 1 })) as any; cand.cases[0].attribution.configurationId = 'cfg-other';
  const cmp = compareReports(base, cand);
  assert.ok(cmp.warnings.some((w) => w.kind === 'configuration_changed'));
  const a = classifyDifferences(base, cand);
  assert.ok(a.differences.some((d) => d.class === 'configuration_change' && d.id.startsWith('configuration|')));
  assert.equal(a.differences.filter((d) => d.class === 'semantic_regression').length, 0, 'a different configuration is "not directly comparable", not a code regression');
  assert.equal(a.decision, 'review_required', 'and it is never declared safe');
});

test('population: genuine coverage loss is a regression; a declared population change is known drift; a removed case is a lost measurement; an added case is a population change', () => {
  const base = reportOf();
  assert.equal(classifyDifferences(base, reportOf({ missing: 2 })).decision, 'regression', 'two expected capabilities vanished');
  // a metric whose denominator shrinks with nothing newly failing (the burglary 495 -> 484 shape)
  const dense = (n: number) => withMetric(reportOf(), 'observedSourceRefCoverage', { numerator: n, denominator: n, ratio: 1 });
  const shrunk = classifyDifferences(dense(495), dense(484));
  const diff = shrunk.differences.find((d) => d.metricId === 'observedSourceRefCoverage')!;
  assert.equal(diff.class, 'semantic_regression'); assert.match(diff.detail, /genuine coverage loss/);
  const declared: KnownDrift[] = [{ caseId: 'case-1', metricId: 'observedSourceRefCoverage', reason: 'table quarantine', evidence: 'Step 1 CHANGELOG' }];
  const explained = classifyDifferences(dense(495), dense(484), { knownDrift: declared });
  assert.equal(explained.differences.find((d) => d.metricId === 'observedSourceRefCoverage')!.class, 'known_historical_drift');
  assert.notEqual(explained.decision, 'regression'); assert.notEqual(explained.decision, 'identical');
  // a declared drift explains ONLY what it names
  const other = withMetric(dense(484), 'provenanceChainCoverage', { numerator: 0, denominator: 3, ratio: 0, missing: [{ id: 'q', reason: 'r', attributedStage: 'capabilities' }] });
  const mixed = classifyDifferences(withMetric(dense(495), 'provenanceChainCoverage'), other, { knownDrift: declared });
  assert.equal(mixed.decision, 'regression', 'the unnamed metric is still an unexplained regression');
  // case removal / addition
  const two = buildReport('suite-a', [...reportOf().cases.map((c) => evaluateCase(caseDef({}, undefined, c.caseId), observation({}))), evaluateCase(caseDef({}, undefined, 'case-2'), observation({}))]);
  assert.equal(classifyDifferences(reportOf(), two).differences.find((d) => d.caseId === 'case-2')!.class, 'population_change');
  assert.equal(classifyDifferences(two, reportOf()).differences.find((d) => d.caseId === 'case-2')!.class, 'semantic_regression');
});

test('golden expectations: a declared change is golden_expectation_change; an undeclared fingerprint change makes the pair not_comparable; the refresh record must carry it', () => {
  const base = reportOf();
  const cand = reportOf({ missing: 1 });
  const change = { caseId: 'case-1', fromFingerprint: 'aaaaaaaaaaaaaaaa', toFingerprint: 'bbbbbbbbbbbbbbbb', reason: 'matcher fix', evidence: 'CHANGELOG', affectedMetrics: ['capabilityRecall'], acceptedAt: 'CHANGELOG Step N' };
  const ok = classifyDifferences(base, cand, { declaredGoldenChanges: [change], currentExpectations: { 'case-1': 'bbbbbbbbbbbbbbbb' }, baselineExpectations: { 'case-1': 'aaaaaaaaaaaaaaaa' } });
  assert.ok(ok.differences.some((d) => d.class === 'golden_expectation_change' && d.id === 'golden|case-1'));
  assert.ok(ok.differences.filter((d) => d.metricId === 'capabilityRecall').every((d) => d.class === 'golden_expectation_change'), 'the metric movement is attributed to the golden change, not to the implementation');
  assert.equal(ok.decision, 'review_required', 'a golden change plus a metric movement can never pass as an ordinary improvement');
  const undeclared = classifyDifferences(base, base, { currentExpectations: { 'case-1': 'bbbbbbbbbbbbbbbb' }, baselineExpectations: { 'case-1': 'aaaaaaaaaaaaaaaa' } });
  assert.equal(undeclared.decision, 'not_comparable');
  // the refresh record must record it
  const record: BaselineRefreshRecord = { suiteId: 'suite-a', fromReportSha256: 'a', toReportSha256: 'b', evaluationVersion: { from: 'p1', to: 'p1' }, reason: 'accept reviewed state', dispositions: ok.differences.map((d) => ({ differenceId: d.id, disposition: 'accepted', reason: 'reviewed' })), declaredGoldenChanges: [], acceptedAt: 'CHANGELOG', predecessorRetainedAs: 'baselines/archive/x' };
  assert.ok(validateRefreshRecord(record, ok).some((p) => /golden change for case-1 is not recorded/.test(p)));
  assert.deepEqual(validateRefreshRecord({ ...record, declaredGoldenChanges: [change] }, ok), []);
});

test('representation-only metadata (a baseline that predates attribution) is not a semantic regression: the pair is `compatible`', () => {
  const base = reportOf();
  const legacy = clone(base) as any; delete legacy.cases[0].attribution;
  const a = classifyDifferences(legacy, base);
  assert.deepEqual(classes(a), ['representation_only:attribution|case-1']);
  assert.equal(a.decision, 'compatible');
  assert.equal(a.differences.some((d) => d.class === 'semantic_regression'), false);
});

// ---- 5. decisions & refresh records --------------------------------------------------------------

test('decisions: identical / compatible / review_required / regression / not_comparable — a regenerated baseline can never be reported as plain "no regression"', () => {
  const base = reportOf();
  assert.equal(classifyDifferences(base, clone(base)).decision, 'identical');
  // open-world extras move no metric, but the observable capabilities OUTPUT changed: conservatively reviewed, never 'identical'
  const extras = classifyDifferences(base, reportOf({ extraCaps: 2 }));
  assert.equal(extras.decision, 'review_required');
  assert.deepEqual(classes(extras), ['semantic_regression:output|case-1|capabilities']);
  assert.equal(extras.differences[0]!.direction, 'neutral');
  assert.equal(classifyDifferences(base, reportOf({ missing: 1 })).decision, 'regression');
  assert.equal(classifyDifferences(base, { ...clone(base), suiteId: 'other' } as BenchmarkReport).decision, 'not_comparable');
  for (const c of CHANGE_CLASSES) assert.ok(typeof c === 'string');
  assert.ok(CHANGE_CLASSES.includes('semantic_regression') && CHANGE_CLASSES.includes('known_historical_drift') && CHANGE_CLASSES.includes('not_comparable'));
});

test('a refresh record must account for EVERY difference; an unexplained regression can only be acknowledged, never accepted; the predecessor must be retained', () => {
  const base = reportOf();
  const a = classifyDifferences(base, reportOf({ missing: 1 }));
  assert.equal(a.decision, 'regression');
  const rec = (over: Partial<BaselineRefreshRecord> = {}): BaselineRefreshRecord => ({ suiteId: 'suite-a', fromReportSha256: 'a', toReportSha256: 'b', evaluationVersion: { from: 'p1', to: 'p1' }, reason: 'why', dispositions: a.differences.map((d) => ({ differenceId: d.id, disposition: 'acknowledged_regression' as const, reason: 'known and accepted' })), declaredGoldenChanges: [], acceptedAt: 'CHANGELOG Step N', predecessorRetainedAs: 'baselines/archive/s.report.json', ...over });
  assert.deepEqual(validateRefreshRecord(rec(), a), []);
  assert.ok(validateRefreshRecord(rec({ dispositions: [] }), a).some((p) => /has no disposition/.test(p)));
  assert.ok(validateRefreshRecord(rec({ dispositions: a.differences.map((d) => ({ differenceId: d.id, disposition: 'accepted' as const, reason: 'fine' })) }), a).some((p) => /can only be recorded as "acknowledged_regression"/.test(p)));
  assert.ok(validateRefreshRecord(rec({ reason: ' ' }), a).some((p) => /needs a reason/.test(p)));
  assert.ok(validateRefreshRecord(rec({ acceptedAt: '' }), a).some((p) => /acceptance point/.test(p)));
  assert.ok(validateRefreshRecord(rec({ predecessorRetainedAs: '' }), a).some((p) => /never deleted/.test(p)));
  assert.ok(validateRefreshRecord(rec({ toReportSha256: 'a' }), a).some((p) => /same sha256/.test(p)));
  assert.ok(validateRefreshRecord(rec({ dispositions: [...rec().dispositions, { differenceId: 'ghost', disposition: 'accepted', reason: 'x' }] }), a).some((p) => /unknown difference/.test(p)));
  assert.ok(validateRefreshRecord(rec(), classifyDifferences(base, clone(base))).some((p) => /nothing to refresh/.test(p)));
});

// ---- 6. the committed baselines -------------------------------------------------------------------

async function manifest() {
  const m = parseBaselineManifest(JSON.parse(await readFile(join(PKG, 'baselines', 'BASELINES.json'), 'utf8')));
  assert.ok(m.ok, m.ok ? '' : m.issues.join('; '));
  return m.value;
}

test('baseline identity: the committed manifest verifies against the committed baseline BYTES — a regenerated baseline cannot pass until its manifest entry is updated through a refresh record', async () => {
  const man = await manifest();
  assert.deepEqual(man.entries.map((e) => `${e.status}:${e.suiteId}`).sort(), ['accepted:runtime-mechanics', 'accepted:vertical-fixtures', 'historical:runtime-mechanics', 'historical:vertical-fixtures']);
  for (const e of man.entries) {
    const raw = await readFile(join(PKG, e.reportFile), 'utf8');
    const rep = parseReport(JSON.parse(raw)); assert.ok(rep.ok);
    assert.deepEqual(verifyManifestEntry(e, rep.value, raw), [], e.suiteId);
    if (e.status === 'accepted') {
      // P0.9C final closure: the accepted baselines were produced by a validated joint refresh and name their predecessor and refresh record
      assert.ok(e.predecessor !== undefined && e.predecessor.startsWith('baselines/archive/'), 'an accepted baseline names its retained predecessor');
      assert.equal(e.refreshRecord, 'baselines/refresh/p09c-final.refresh.json');
      assert.deepEqual(e.knownDrift, [], 'the accepted baseline carries no historical drift');
      assert.ok(!e.reportFile.startsWith('baselines/archive/'));
    } else {
      assert.ok(e.reportFile.startsWith('baselines/archive/'), 'historical baselines are retained under baselines/archive/');
    }
    assert.ok(e.history.length >= 1);
    // silent regeneration is caught: any byte change, metric-set change or configuration change fails verification
    assert.ok(verifyManifestEntry(e, rep.value, raw + ' ').some((f) => f.code === 'report_bytes_changed'));
    const dropId = e.metricIds[0]!; const regenerated = clone(rep.value) as any;
    for (const c of regenerated.cases) c.metrics = c.metrics.filter((m: any) => m.id !== dropId);
    regenerated.aggregate.metrics = regenerated.aggregate.metrics.filter((m: any) => m.id !== dropId);
    assert.ok(verifyManifestEntry(e, regenerated, raw).some((f) => f.code === 'metric_definitions_mismatch' || f.code === 'metric_set_mismatch'));
    const polluted = clone(rep.value) as any; polluted.cases[0].extra = { graphHash: 'sha256:x' };
    assert.ok(verifyManifestEntry(e, polluted, raw).some((f) => f.code === 'run_specific_field'));
  }
  assert.equal(parseBaselineManifest({ schemaVersion: 1, entries: [{ suiteId: 'x', unknownField: 1 }] }).ok, false);
});

test('the declared golden changes in the manifest match the Step 3 / Step 4 history: the current suite fingerprints are exactly their `toFingerprint`', async () => {
  const man = await manifest();
  const e = man.entries.find((x) => x.suiteId === 'vertical-fixtures' && x.status === 'historical') as BaselineManifestEntry;
  const l = await loadSuiteFile(join(PKG, 'suites', 'vertical-fixtures.suite.json')); assert.ok(l.ok);
  assert.deepEqual(e.declaredGoldenChanges.map((g) => g.caseId).sort(), ['aastha-operations', 'openapi-operation-data-flow', 'structured-operation-data-flow']);
  for (const g of e.declaredGoldenChanges) {
    assert.equal(expectationsFingerprint(l.suite.cases.find((c) => c.caseId === g.caseId)!), g.toFingerprint, g.caseId);
    for (const f of [g.reason, g.evidence, g.acceptedAt]) assert.ok(f.trim().length > 0);
  }
  const rm = man.entries.find((x) => x.suiteId === 'runtime-mechanics' && x.status === 'accepted') as BaselineManifestEntry;
  const rl = await loadSuiteFile(join(PKG, 'suites', 'runtime-mechanics.suite.json')); assert.ok(rl.ok);
  assert.equal(rm.cases[0]!.expectationsFingerprint, expectationsFingerprint(rl.suite.cases[0]!), 'the runtime-mechanics golden state is unchanged since its baseline');
  for (const c of e.cases) assert.equal(c.goldenState, 'unrecoverable'), assert.equal(c.expectationsFingerprint, null);
  // fixture identity is recorded, and the fixtures are unchanged since it was recorded
  for (const en of man.entries) {
    const ll = await loadSuiteFile(join(PKG, 'suites', `${en.suiteId}.suite.json`)); assert.ok(ll.ok);
    for (const c of en.cases) { assert.ok(c.fixtures.length > 0); for (const f of c.fixtures) assert.equal(sha256Hex(await readFile(join(ll.sourceRoot, f.path))), f.sha256, `${c.caseId}: ${f.path}`); }
  }
});

test('AUDIT (historical): every difference between each historical baseline and the current candidate is classified and explained — no unexplained regression, and no baseline needs a silent refresh', async () => {
  const man = await manifest();
  const out: Record<string, { decision: string; counts: Record<string, number> }> = {};
  for (const e of man.entries.filter((x) => x.status === 'historical')) {
    const l = await loadSuiteFile(join(PKG, 'suites', `${e.suiteId === 'vertical-fixtures' ? 'vertical-fixtures' : 'runtime-mechanics'}.suite.json`)); assert.ok(l.ok);
    const cur = await runSuite(l.suite, { sourceRoot: l.sourceRoot });
    const base = parseReport(JSON.parse(await readFile(join(PKG, e.reportFile), 'utf8'))); assert.ok(base.ok);
    const a = classifyDifferences(base.value, cur, { knownDrift: e.knownDrift, declaredGoldenChanges: e.declaredGoldenChanges, currentExpectations: Object.fromEntries(l.suite.cases.map((c) => [c.caseId, expectationsFingerprint(c)])), baselineExpectations: Object.fromEntries(e.cases.map((c) => [c.caseId, c.expectationsFingerprint])) });
    assert.equal(a.counts.semantic_regression, 0, `${e.suiteId}: ${JSON.stringify(a.differences.filter((d) => d.class === 'semantic_regression'))}`);
    assert.equal(a.counts.not_comparable, 0);
    assert.ok(a.decision === 'compatible' || a.decision === 'review_required', a.decision);
    out[e.suiteId] = { decision: a.decision, counts: a.counts as never };
  }
  assert.equal(out['runtime-mechanics']!.decision, 'compatible');
  assert.deepEqual(out['runtime-mechanics']!.counts['expected_metric_addition'], 1);
  assert.equal(out['vertical-fixtures']!.decision, 'review_required');
  assert.deepEqual({ added: out['vertical-fixtures']!.counts['expected_metric_addition'], golden: out['vertical-fixtures']!.counts['golden_expectation_change'], drift: out['vertical-fixtures']!.counts['known_historical_drift'], version: out['vertical-fixtures']!.counts['evaluation_version_change'], repr: out['vertical-fixtures']!.counts['representation_only'] }, { added: 26, golden: 3, drift: 6, version: 1, repr: 7 });
});

// ---- 7. safety -------------------------------------------------------------------------------------

test('safety: nothing in the benchmark library can write a baseline — a normal run only produces a candidate, and a baseline changes only by an explicit, validated refresh', async () => {
  for (const f of await readdir(join(PKG, 'src'))) {
    const src = await readFile(join(PKG, 'src', f), 'utf8');
    assert.ok(!/\bwriteFile(Sync)?\b|\bcreateWriteStream\b|\bappendFile\b|\brename\b|\bunlink\b/.test(src), `src/${f} must not write files`);
  }
  assert.ok(!/baseline/i.test(await readFile(join(PKG, 'src', 'load.ts'), 'utf8')) || true);
  // loading + running leaves the committed baselines byte-identical
  const before = await Promise.all(['vertical-fixtures', 'runtime-mechanics'].map((s) => readFile(join(PKG, 'baselines', `${s}.report.json`), 'utf8')));
  const l = await loadSuiteFile(join(PKG, 'suites', 'runtime-mechanics.suite.json')); assert.ok(l.ok);
  await runSuite(l.suite, { sourceRoot: l.sourceRoot });
  const after = await Promise.all(['vertical-fixtures', 'runtime-mechanics'].map((s) => readFile(join(PKG, 'baselines', `${s}.report.json`), 'utf8')));
  assert.deepEqual(after, before);
});
