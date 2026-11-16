// UW-13 — the evaluation harness: thresholds stay proposals until ratified (UAC-19), the register covers R1 to R18 with owners and a
// pilot gate (UAC-20), and deterministic reports are reproducible and kept current.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildEvaluationReport,
  checkRegister,
  checkThresholds,
  renderReportMarkdown,
  validateThresholds,
  type Measure,
  type RegisterItem,
  type Threshold,
} from '../src/index.js';
import { SUITES } from '../suites/index.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const thresholds = (JSON.parse(readFileSync(`${ROOT}evaluation/thresholds.json`, 'utf8')) as { thresholds: Threshold[] }).thresholds;
const register = (JSON.parse(readFileSync(`${ROOT}evaluation/register.json`, 'utf8')) as { items: RegisterItem[] }).items;
const m = (id: string, value: number | null): Measure => ({ id, title: id, unit: 'ratio', better: 'higher', value });

test('a threshold is a proposal until the owner ratifies it; only ratified thresholds pass or fail', () => {
  const ts: Threshold[] = [
    { measure: 's/a', min: 0.9, status: 'proposed', rationale: 'r' },
    { measure: 's/b', min: 0.9, status: 'ratified', rationale: 'r', ratifiedBy: 'owner', ratifiedAt: '2026-11-13' },
    { measure: 's/c', max: 0, status: 'ratified', rationale: 'r', ratifiedBy: 'owner', ratifiedAt: '2026-11-13' },
    { measure: 's/d', min: 1, status: 'ratified', rationale: 'r', ratifiedBy: 'owner', ratifiedAt: '2026-11-13' },
    { measure: 's/e', min: 1, status: 'proposed', rationale: 'r' },
  ];
  assert.deepEqual(
    checkThresholds(ts, [m('s/a', 0.1), m('s/b', 0.95), m('s/c', 2), m('s/d', null)]).map((c) => [c.measure, c.outcome]),
    [
      ['s/a', 'proposal'],
      ['s/b', 'pass'],
      ['s/c', 'fail'],
      ['s/d', 'no-cases'],
      ['s/e', 'not-measured'],
    ],
  );
  assert.deepEqual(
    validateThresholds([
      { measure: 'x', status: 'ratified', rationale: 'r' } as Threshold,
      { measure: 'x', min: 1, status: 'proposed', rationale: ' ' },
    ]),
    ['x: needs min or max', 'x: a ratified threshold records who ratified it and when', 'x: defined twice', 'x: needs a rationale'],
  );
});

test('the register must hold R1 to R18 with owners; accepted and closed items carry their basis; pilot blockers are listed', () => {
  const base = (id: string, extra: Partial<RegisterItem> = {}): RegisterItem => ({
    id,
    title: id,
    pilotBlocking: false,
    owner: 'owner',
    status: 'open',
    evidence: [],
    ...extra,
  });
  const items = Array.from({ length: 18 }, (_, i) => base(`R${i + 1}`));
  assert.deepEqual(checkRegister(items).problems, []);
  const r = checkRegister([
    ...items.slice(1),
    base('R1', { pilotBlocking: true, status: 'accepted' }),
    base('R2', { pilotBlocking: true, status: 'closed' }),
  ]);
  assert.ok(r.problems.includes('R1: an accepted item records who accepted the risk and when'));
  assert.ok(r.problems.includes('R2: a closed item cites its evidence'));
  assert.ok(r.problems.includes('R2: listed twice'));
  assert.deepEqual(checkRegister(items.slice(2)).problems, ['R1 is missing from the register', 'R2 is missing from the register']);
  assert.deepEqual(
    checkRegister([
      ...items.slice(1),
      base('R1', { pilotBlocking: true, status: 'accepted', acceptedBy: 'owner', acceptedAt: '2026-11-13' }),
    ]).pilotBlockers,
    [],
  );
});

test('the committed register: R1 to R18, ten pilot-blocking items, every one with an owner, and every cited file exists', () => {
  const r = checkRegister(register);
  assert.deepEqual(r.problems, []);
  assert.equal(register.length, 18);
  assert.deepEqual(
    register.filter((i) => i.pilotBlocking).map((i) => i.id),
    ['R1', 'R2', 'R3', 'R4', 'R6', 'R10', 'R11', 'R12', 'R13', 'R17'],
  );
  for (const i of register) for (const e of i.evidence) assert.ok(existsSync(`${ROOT}${e}`), `${i.id} cites ${e}, which does not exist`);
});

test('the committed thresholds are valid, all still proposals, and each names a measure a suite produces', async () => {
  assert.deepEqual(validateThresholds(thresholds), []);
  assert.ok(
    thresholds.every((t) => t.status === 'proposed'),
    'nothing is ratified until the owner does it',
  );
  const results = [];
  for (const s of SUITES.filter((x) => x.slow !== true)) results.push(await s.run());
  const measured = new Set(results.flatMap((r) => r.measures.map((x) => x.id)));
  const fastSuites = new Set(results.map((r) => r.suite));
  for (const t of thresholds)
    if (fastSuites.has(t.measure.split('/')[0]!)) assert.ok(measured.has(t.measure), `${t.measure} is not produced by its suite`);
});

test('deterministic suites give byte-identical reports run after run, and every suite states its limits', async () => {
  const run = async () => {
    const results = [];
    for (const s of SUITES.filter((x) => x.slow !== true)) results.push(await s.run());
    return JSON.stringify(buildEvaluationReport({ results, thresholds, register, run: { node: '22' } }));
  };
  const a = await run();
  assert.equal(await run(), a);
  const report = JSON.parse(a) as ReturnType<typeof buildEvaluationReport>;
  for (const s of report.suites) {
    assert.ok(s.limits.length > 0, `${s.suite} states no limits`);
    for (const set of s.sets) assert.match(set.contentHash, /^[0-9a-f]{64}$/);
  }
  assert.equal(report.verdict.pilotGate, 'blocked');
});

test('a ratified threshold that fails shows in the verdict and the report', () => {
  const report = buildEvaluationReport({
    results: [
      { suite: 's', title: 'S', uac: ['UAC-19'], mode: 'deterministic', sets: [], measures: [m('s/a', 0.5)], notes: [], limits: ['l'] },
    ],
    thresholds: [{ measure: 's/a', min: 0.9, status: 'ratified', rationale: 'r', ratifiedBy: 'owner', ratifiedAt: '2026-11-13' }],
    register,
    run: { node: '22' },
  });
  assert.deepEqual(report.verdict.failedRatified, ['s/a']);
  assert.match(renderReportMarkdown(report), /Ratified thresholds failed: s\/a\./);
  assert.match(renderReportMarkdown(report), /\| s\/a \| 50\.0% \| ≥ 0\.9 \(ratified, FAILED\) \|/);
});

test(
  'evaluation/REPORT.md is current: it matches a fresh run of every suite (regenerate with `npm run eval -- --write`)',
  { timeout: 300_000 },
  async () => {
    const results = [];
    for (const s of SUITES) results.push(await s.run());
    const fresh = renderReportMarkdown(
      buildEvaluationReport({ results, thresholds, thresholdProblems: validateThresholds(thresholds), register, run: {} }),
    );
    assert.equal(
      readFileSync(`${ROOT}evaluation/REPORT.md`, 'utf8'),
      fresh,
      'the committed report is stale: run `npm run eval -- --write`',
    );
  },
);
