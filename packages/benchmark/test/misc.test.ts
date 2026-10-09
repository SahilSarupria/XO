import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fromJson } from '@xo/xoir';
import { buildReport, compareReports, formatReport, formatRegression, parseReport, runSuite, validateSuiteDefinition, canonicalJson, fingerprintOf } from '../src/index.js';
import { renderRuntimeMechanicsJson } from '../fixtures/build-xoir-fixtures.js';

const PKG = fileURLToPath(new URL('../', import.meta.url));

// ---------------------------------------------------------------------------
// Empty / expectation-free benchmarks
// ---------------------------------------------------------------------------

test('EMPTY benchmark: zero cases => a valid report that says it measured nothing — no metric, no fabricated percentage', async () => {
  const validated = validateSuiteDefinition({ schemaVersion: 1, suiteId: 'empty', cases: [] });
  assert.ok(validated.ok);
  const report = await runSuite(validated.value, { sourceRoot: PKG });
  assert.deepEqual([report.caseCount, report.evaluatedCaseCount, report.harnessErrorCount, report.measured], [0, 0, 0, false]);
  assert.deepEqual(report.aggregate.metrics, []);
  assert.deepEqual(report.aggregate.observed.workflows, { total: 0, totalSteps: 0, byExecutability: {} });
  const text = formatReport(report);
  assert.match(text, /NOTHING WAS MEASURED/);
  assert.doesNotMatch(text, /100\.0%/);
  // and it compares cleanly with itself
  assert.equal(compareReports(report, report).classification, 'no_change');
});

test('a case with NO expectations still observes the pipeline (distributions are reported) but measures nothing: `measured` stays false because provenance coverage is descriptive only', async () => {
  const validated = validateSuiteDefinition({ schemaVersion: 1, suiteId: 'no-expect', sourceRoot: '../../..', cases: [{ caseId: 'c', sources: [{ kind: 'document', path: 'examples/vertical-test/synthetic-claim-rules.txt' }], expect: {} }] });
  assert.ok(validated.ok);
  const report = await runSuite(validated.value, { sourceRoot: fileURLToPath(new URL('../../../', import.meta.url)) });
  assert.equal(report.measured, false);
  // (P0.9C Steps 4-6) producer coverage, provenance chain coverage and cross-path consistency are descriptive too (no golden expectation), so `measured` stays false.
  assert.deepEqual(report.aggregate.metrics.map((m) => m.id), ['crossPathConsistency', 'observedSourceRefCoverage', 'producerAttributionCoverage', 'provenanceChainCoverage']);
  assert.equal(report.aggregate.observed.capabilities.total, 2);
  assert.equal(report.cases[0]!.observed.capabilities.byExecutionClass['deterministic_rule'], 2);
});

// ---------------------------------------------------------------------------
// Report + baseline plumbing
// ---------------------------------------------------------------------------

test('parseReport rejects things that are not reports; accepts what runSuite wrote', async () => {
  for (const bad of [null, [], {}, { schemaVersion: 2, suiteId: 's', cases: [], aggregate: { metrics: [] } }, { schemaVersion: 1, suiteId: 5, cases: [], aggregate: { metrics: [] } }, { schemaVersion: 1, suiteId: 's', cases: {}, aggregate: { metrics: [] } }, { schemaVersion: 1, suiteId: 's', cases: [] }]) {
    assert.equal(parseReport(bad).ok, false, JSON.stringify(bad));
  }
  assert.ok(parseReport(buildReport('s', [])).ok);
  assert.ok(parseReport(JSON.parse(await readFile(`${PKG}baselines/runtime-mechanics.report.json`, 'utf8'))).ok);
});

test('formatReport / formatRegression render every metric with numerator/denominator and never invent a combined score', async () => {
  const baseline = JSON.parse(await readFile(`${PKG}baselines/vertical-fixtures.report.json`, 'utf8'));
  const parsed = parseReport(baseline);
  assert.ok(parsed.ok);
  const text = formatReport(parsed.value, { itemLimit: 2 });
  assert.match(text, /semanticRecall\s+compile\s+28\/30\s+93\.3%/);
  assert.match(text, /each metric is independent — there is no combined score/);
  assert.match(text, /… \d+ more/);
  assert.doesNotMatch(text, /overall score/i);
  assert.match(formatRegression(compareReports(parsed.value, parsed.value)), /NO_CHANGE/);
});

// ---------------------------------------------------------------------------
// Hand-built fixture stays reproducible
// ---------------------------------------------------------------------------

test('the committed hand-built XOIR fixture is exactly what its generator produces, and loads as a valid graph', async () => {
  const committed = await readFile(`${PKG}fixtures/xoir/runtime-mechanics.xoir.json`, 'utf8');
  assert.equal(committed, renderRuntimeMechanicsJson());
  const loaded = fromJson(JSON.parse(committed));
  assert.ok(loaded.ok);
  assert.equal(loaded.value.allNodes().filter((n) => n.kind === 'capability').length, 8);
});

// ---------------------------------------------------------------------------
// Canonical JSON / fingerprints
// ---------------------------------------------------------------------------

test('canonicalJson/fingerprintOf: key order is irrelevant, undefined is dropped, and different content gives a different fingerprint', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: 2 } }), canonicalJson({ a: { c: 2, d: [1, { z: 1 }] }, b: 1 }));
  assert.equal(fingerprintOf({ a: 1, b: 2 }), fingerprintOf({ b: 2, a: 1 }));
  assert.notEqual(fingerprintOf({ a: 1 }), fingerprintOf({ a: 2 }));
  assert.equal(fingerprintOf([1, 2]) === fingerprintOf([2, 1]), false, 'array order IS significant in a fingerprint (only used for stage outputs that are sorted first)');
});
