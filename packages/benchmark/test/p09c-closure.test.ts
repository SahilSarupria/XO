import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReport, classifyDifferences, evaluateCase, expectationsFingerprint, loadSuiteFile, parseBaselineManifest, parseReport, runSuite, sha256Hex, verifyManifestEntry,
  type BaselineManifestEntry, type BenchmarkReport,
} from '../src/index.js';
import { cap, caseDef, observation } from './helpers.js';

/** P0.9C final closure: the controlled joint refresh, Decision C (declared population changes) and the frozen state. */

const PKG = fileURLToPath(new URL('../', import.meta.url));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const man = async (): Promise<readonly BaselineManifestEntry[]> => { const m = parseBaselineManifest(JSON.parse(await readFile(join(PKG, 'baselines', 'BASELINES.json'), 'utf8'))); assert.ok(m.ok); return m.value.entries; };
const SUITES = ['vertical-fixtures', 'runtime-mechanics'] as const;

test('the accepted baselines are reproduced EXACTLY by the current evaluation (decision identical, evaluation version unchanged)', async () => {
  const entries = (await man()).filter((e) => e.status === 'accepted');
  assert.deepEqual(entries.map((e) => e.suiteId).sort(), [...SUITES].sort());
  for (const e of entries) {
    const l = await loadSuiteFile(join(PKG, 'suites', `${e.suiteId}.suite.json`)); assert.ok(l.ok);
    const raw = await readFile(join(PKG, e.reportFile), 'utf8');
    const cur = await runSuite(l.suite, { sourceRoot: l.sourceRoot });
    assert.equal(JSON.stringify(cur, null, 2) + '\n', raw, e.suiteId);
    assert.equal(sha256Hex(raw), e.reportSha256);
    assert.equal(e.evaluationVersion, 'p0.9c-1');
    const base = parseReport(JSON.parse(raw)); assert.ok(base.ok);
    assert.equal(classifyDifferences(base.value, cur).decision, 'identical');
    assert.deepEqual(verifyManifestEntry(e, base.value, raw), []);
  }
});

test('the historical predecessors are retained, byte-unchanged, with their declared history', async () => {
  const entries = await man();
  const hist = entries.filter((e) => e.status === 'historical');
  assert.deepEqual(hist.map((e) => sha256Hex('') && e.reportSha256.slice(0, 16)).sort(), ['1b98f1acd213e750', 'ea4d33081f6b990e']);
  for (const e of hist) assert.equal(sha256Hex(await readFile(join(PKG, e.reportFile), 'utf8')), e.reportSha256, e.reportFile);
  const vh = hist.find((e) => e.suiteId === 'vertical-fixtures')!;
  assert.equal(vh.knownDrift.length, 6, 'historical known_historical_drift records are not rewritten');
  assert.equal(vh.declaredGoldenChanges.length, 3);
  assert.equal(hist.find((e) => e.suiteId === 'runtime-mechanics')!.knownDrift.length, 0);
  for (const e of entries.filter((x) => x.status === 'accepted')) assert.ok(hist.some((h) => h.reportFile === e.predecessor), `${e.suiteId}: predecessor is a retained historical entry`);
  assert.equal((await readdir(join(PKG, 'baselines', 'archive'))).length, 2);
});

test('the refresh record is auditable: both suites refreshed together, every difference accounted for, no regression, evaluation version unchanged', async () => {
  const rec = JSON.parse(await readFile(join(PKG, 'baselines', 'refresh', 'p09c-final.refresh.json'), 'utf8')) as any;
  assert.equal(rec.refreshedTogether, true);
  assert.equal(rec.evaluationVersion, 'p0.9c-1');
  assert.deepEqual(rec.suites.map((s: any) => s.suiteId).sort(), [...SUITES].sort());
  const by = Object.fromEntries(rec.suites.map((s: any) => [s.suiteId, s]));
  assert.deepEqual({ ...by['vertical-fixtures'].counts, }, { semantic_regression: 0, semantic_improvement: 0, expected_metric_addition: 26, golden_expectation_change: 3, configuration_change: 0, population_change: 0, evaluation_version_change: 1, representation_only: 7, known_historical_drift: 6, not_comparable: 0 });
  assert.equal(by['runtime-mechanics'].counts.expected_metric_addition, 1);
  assert.equal(by['runtime-mechanics'].counts.semantic_regression + by['vertical-fixtures'].counts.semantic_regression, 0);
  for (const s of rec.suites) { assert.ok(s.reason.trim().length > 0); assert.ok(s.dispositions.every((d: any) => d.disposition === 'accepted' && d.reason.trim().length > 0)); assert.ok(s.predecessorRetainedAs.startsWith('baselines/archive/')); }
  assert.ok(rec.knownLimitations.length >= 5 && rec.deferred.length === 2);
});

// ---- Decision C ---------------------------------------------------------------------------------

function pair(kind: 'metric' | 'stage'): { base: BenchmarkReport; cur: BenchmarkReport } {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `k${i}`, name: { equals: `Cap${i}` } }));
  const mk = (missing: number, extra: number): BenchmarkReport => buildReport('suite-a', [evaluateCase(caseDef({ capabilities: { items } }, undefined, 'case-1'), observation({ capabilities: [...items.slice(0, 4 - missing).map((_, i) => cap(`c${i}`, `Cap${i}`)), ...Array.from({ length: extra }, (_, i) => cap(`x${i}`, `Extra${i}`))] }))]);
  return kind === 'metric' ? { base: mk(0, 0), cur: mk(1, 0) } : { base: mk(0, 0), cur: mk(0, 2) };
}

test('Decision C: a DECLARED future population change classifies as population_change; the same declaration as historical drift stays known_historical_drift', () => {
  const { base, cur } = pair('metric');
  const plain = classifyDifferences(base, cur);
  const target = plain.differences.find((d) => d.metricId !== undefined && d.class === 'semantic_regression');
  assert.ok(target?.metricId !== undefined);
  const decl = [{ caseId: 'case-1', metricId: target.metricId as never, reason: 'intentional population change', evidence: 'test' }];
  const asPop = classifyDifferences(base, cur, { declaredPopulationChanges: decl });
  const asHist = classifyDifferences(base, cur, { knownDrift: decl });
  assert.equal(asPop.differences.find((d) => d.id === target.id)!.class, 'population_change');
  assert.equal(asHist.differences.find((d) => d.id === target.id)!.class, 'known_historical_drift');
  assert.equal(asPop.counts.known_historical_drift, 0);
  // STRICT: a declaration for another metric / case explains nothing here
  const other = classifyDifferences(base, cur, { declaredPopulationChanges: [{ caseId: 'case-2', metricId: target.metricId as never, reason: 'r', evidence: 'e' }] });
  assert.equal(other.differences.find((d) => d.id === target.id)!.class, plain.differences.find((d) => d.id === target.id)!.class);
});

test('Decision C: stage-output declarations classify as population_change; golden declarations keep precedence', () => {
  const { base, cur } = pair('stage');
  const stageDiff = classifyDifferences(base, cur).differences.find((d) => d.id.startsWith('output|case-1|'));
  assert.ok(stageDiff !== undefined);
  {
    const stage = stageDiff.id.split('|')[2] as never;
    const a = classifyDifferences(base, cur, { declaredPopulationChanges: [{ caseId: 'case-1', stage, reason: 'r', evidence: 'e' }] });
    assert.equal(a.differences.find((d) => d.id === stageDiff.id)!.class, 'population_change');
  }
  const m = pair('metric');
  const fp = expectationsFingerprint(caseDef({}, undefined, 'case-1'));
  const g = { caseId: 'case-1', fromFingerprint: 'aaaaaaaaaaaaaaaa', toFingerprint: fp, reason: 'r', evidence: 'e', affectedMetrics: [], acceptedAt: 'x' };
  const a = classifyDifferences(m.base, m.cur, { declaredGoldenChanges: [g], currentExpectations: { 'case-1': fp }, baselineExpectations: { 'case-1': 'aaaaaaaaaaaaaaaa' }, declaredPopulationChanges: [{ caseId: 'case-1', metricId: 'capabilityRecall' as never, reason: 'r', evidence: 'e' }] });
  assert.ok(a.differences.some((d) => d.class === 'golden_expectation_change'));
  assert.equal(a.counts.population_change, 0, 'golden-declared outranks a population declaration');
});

test('Decision C: the manifest schema accepts declaredPopulationChanges and refreshRecord and still rejects unknown fields', async () => {
  const entries = clone(await man()) as any[];
  entries[0].declaredPopulationChanges = [{ caseId: 'c', metricId: 'capabilityRecall', reason: 'r', evidence: 'e' }];
  assert.equal(parseBaselineManifest({ schemaVersion: 1, entries }).ok, true);
  entries[0].declaredPopulationChanges[0].bogus = 1;
  assert.equal(parseBaselineManifest({ schemaVersion: 1, entries }).ok, false);
  entries[0].declaredPopulationChanges = 'x';
  assert.equal(parseBaselineManifest({ schemaVersion: 1, entries }).ok, false);
});

// ---- frozen state --------------------------------------------------------------------------------

test('frozen: golden expectation fingerprints are unchanged by the closure', async () => {
  const want: Record<string, string> = { 'synthetic-claim-rules': 'e3f18bb648927dce', 'commercial-property-policy': 'fc7333250a689842', 'aastha-operations': 'bbcc3cdac2c9a97c', 'burglary-policy-schedule': '2384164b83638c58', 'multidoc-burglary-claims': '6eb147408d795389', 'structured-operation-data-flow': 'b294e8d762ce826c', 'openapi-operation-data-flow': 'b294e8d762ce826c', 'runtime-mechanics': '3667e1c4ec1d46ed' };
  const got: Record<string, string> = {};
  for (const s of SUITES) { const l = await loadSuiteFile(join(PKG, 'suites', `${s}.suite.json`)); assert.ok(l.ok); for (const c of l.suite.cases) got[c.caseId] = expectationsFingerprint(c); }
  assert.deepEqual(got, want);
});
