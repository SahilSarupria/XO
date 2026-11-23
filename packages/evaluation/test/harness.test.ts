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

test('ADR 0030: a ratified floor under a proposed target gates now, the target still does not', () => {
  const floor = { rationale: 'no regression', ratifiedBy: 'owner', ratifiedAt: '2026-11-16' };
  const ts: Threshold[] = [
    { measure: 's/a', min: 0.9, status: 'proposed', rationale: 'r', floor: { min: 0.8, ...floor } },
    { measure: 's/b', max: 0, status: 'proposed', rationale: 'r', floor: { max: 7, ...floor } },
  ];
  const checks = checkThresholds(ts, [m('s/a', 0.85), m('s/b', 8)]);
  assert.deepEqual(
    checks.map((c) => [c.measure, c.outcome, c.floor?.outcome]),
    [
      ['s/a', 'proposal', 'pass'],
      ['s/b', 'proposal', 'fail'],
    ],
  );
  assert.deepEqual(validateThresholds([{ measure: 'y', min: 1, status: 'proposed', rationale: 'r', floor: { rationale: ' ' } as never }]), [
    'y: a floor needs min or max',
    'y: a floor records who ratified it and when',
    'y: a floor needs a rationale',
  ]);
});

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
  // UW-5 (ADR 0040): the owner ratified the three entity-resolution thresholds through the W3 handoff (2026-11-17, by delegation).
  // Every other threshold is still a proposal, and a ratified one must say who ratified it and when.
  const ratified = thresholds.filter((t) => t.status !== 'proposed');
  assert.deepEqual(
    ratified.map((t) => t.measure),
    ['entity-resolution/precision', 'entity-resolution/recall', 'entity-resolution/wrong-identity-confirmations'],
    'nothing else is ratified until the owner does it',
  );
  for (const t of ratified)
    assert.ok(t.ratifiedBy !== undefined && t.ratifiedAt !== undefined, `${t.measure} names who ratified it and when`);
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

// ── UW-13 (ADR 0053): the V1 vertical ──
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadV1Set, type V1SetLabels } from '../src/index.js';
import { generateV1Set } from '../sets/generate-v1-synthetic.js';
import { syntheticSet, v1VerticalSuite } from '../suites/v1-vertical.js';

function writeSet(dir: string, labels: V1SetLabels, listCsv: string, docs: string[]): void {
  mkdirSync(join(dir, 'documents'), { recursive: true });
  writeFileSync(join(dir, 'labels.json'), JSON.stringify(labels));
  writeFileSync(join(dir, labels.list), listCsv);
  for (const d of docs) writeFileSync(join(dir, 'documents', d), `%PDF-fake ${d}`);
}
const mini = (
  provenance: 'real' | 'synthetic',
  rows: V1SetLabels['rows'],
  documentsExpected: V1SetLabels['documentsExpected'],
): V1SetLabels => ({
  format: 'xo-v1-set/1',
  provenance,
  labelledBy: 'a test',
  labelledWith: 'blind',
  list: 'list.csv',
  nameColumn: 'Client name',
  emailColumn: 'Email',
  documents: 'documents',
  rows,
  documentsExpected,
});

test('UW-13: the v1-vertical suite names its set’s provenance and content hash and states its limits', async () => {
  const r = await v1VerticalSuite.run();
  assert.equal(r.sets[0]!.provenance, 'synthetic');
  assert.match(r.sets[0]!.contentHash, /^[0-9a-f]{64}$/);
  assert.ok(r.limits.some((l) => l.includes('construction')));
  assert.deepEqual(
    r.measures.map((x) => x.id),
    [
      'v1-vertical/list-reading',
      'v1-vertical/pairing-precision',
      'v1-vertical/pairing-recall',
      'v1-vertical/wrong-pairings',
      'v1-vertical/row-exclusion-accuracy',
      'v1-vertical/document-exclusion-accuracy',
      'v1-vertical/loose-share',
    ],
  );
  assert.equal(r.measures.find((x) => x.id === 'v1-vertical/wrong-pairings')!.value, 0, 'never a document for someone else');
  const names = new Set(thresholds.map((t) => t.measure));
  for (const x of r.measures) assert.ok(names.has(x.id), `${x.id} has a proposed threshold`);
});

test('UW-13: the synthetic V1 set is reproducible from its generator', () => {
  assert.deepEqual(generateV1Set(), syntheticSet(), 'run: node --import tsx packages/evaluation/sets/generate-v1-synthetic.ts --write');
});

test('UW-13: an external V1 set is read where it lies; only its hash and counts enter the result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-v1set-'));
  try {
    writeSet(
      dir,
      mini(
        'real',
        [
          { row: 1, name: 'Zanzibar Quillfeather', email: 'zq-private@example.test', expected: { document: 'Zanzibar Quillfeather.pdf' } },
          { row: 2, name: 'Ottoline Brackenridge', email: 'ob-private@example.test', expected: { excluded: 'no_document' } },
        ],
        [{ name: 'Zanzibar Quillfeather.pdf', expected: { row: 1 } }],
      ),
      'Client name,Email\nZanzibar Quillfeather,zq-private@example.test\nOttoline Brackenridge,ob-private@example.test\n',
      ['Zanzibar Quillfeather.pdf'],
    );
    const loaded = await loadV1Set(dir, ROOT);
    assert.equal(loaded.files, 3);
    assert.match(loaded.hash, /^[0-9a-f]{64}$/);
    const r = await v1VerticalSuite.runExternal!({ externalSets: { 'v1-vertical': dir }, repoRoot: ROOT });
    assert.equal(r!.suite, 'v1-vertical-external');
    assert.equal(r!.sets[0]!.provenance, 'real');
    assert.equal(r!.sets[0]!.contentHash, loaded.hash);
    assert.equal(r!.measures.find((x) => x.id.endsWith('pairing-precision'))!.value, 1);
    // UW-13: no name, email or file name of the set appears in the result.
    const text = JSON.stringify(r);
    for (const secret of ['Zanzibar', 'Quillfeather', 'Ottoline', 'Brackenridge', 'private@example', '.pdf'])
      assert.ok(!text.includes(secret), secret);
    assert.equal(await v1VerticalSuite.runExternal!({ externalSets: {}, repoRoot: ROOT }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UW-13: a real set inside the repository is refused; a symbolic link in a set is refused', async () => {
  const inRepo = mkdtempSync(join(ROOT, '.v1set-test-'));
  try {
    writeSet(inRepo, mini('real', [], []), 'Client name,Email\n', []);
    await assert.rejects(loadV1Set(inRepo, ROOT), /outside the repository/);
    // A synthetic set may live in the repository (the committed one does not, but the rule is about real data).
    writeSet(inRepo, mini('synthetic', [], []), 'Client name,Email\n', []);
    await loadV1Set(inRepo, ROOT);
  } finally {
    rmSync(inRepo, { recursive: true, force: true });
  }
  const dir = mkdtempSync(join(tmpdir(), 'xo-v1set-'));
  try {
    writeSet(dir, mini('real', [], []), 'Client name,Email\n', ['a.pdf']);
    symlinkSync(join(dir, 'labels.json'), join(dir, 'documents', 'link.pdf'));
    await assert.rejects(loadV1Set(dir, ROOT), /symbolic link/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('UW-13: no name, email or file name of a set appears in the report', async () => {
  const report = readFileSync(`${ROOT}evaluation/REPORT.md`, 'utf8') + readFileSync(`${ROOT}evaluation/report.json`, 'utf8');
  const set = syntheticSet();
  for (const row of set.labels.rows.slice(0, 40)) {
    if (row.name !== '') assert.ok(!report.includes(row.name), 'a name from the set is in the report');
    if (row.email !== '') assert.ok(!report.includes(row.email), 'an email from the set is in the report');
  }
  for (const d of set.documentNames.slice(0, 40)) assert.ok(!report.includes(d), 'a file name from the set is in the report');
});

test('UW-13: wrong pairings are counted when a document goes to the wrong row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xo-v1set-'));
  try {
    // The labels say Asha Rao's document belongs to row 2 (Vikram Mehta); XO pairs it with row 1 (Asha Rao), which is a wrong pairing by the labels.
    writeSet(
      dir,
      mini(
        'real',
        [
          { row: 1, name: 'Asha Rao', email: 'a@x.test', expected: { document: 'Vikram Mehta.pdf' } },
          { row: 2, name: 'Vikram Mehta', email: 'v@x.test', expected: { document: 'Asha Rao.pdf' } },
        ],
        [
          { name: 'Asha Rao.pdf', expected: { row: 2 } },
          { name: 'Vikram Mehta.pdf', expected: { row: 1 } },
        ],
      ),
      'Client name,Email\nAsha Rao,a@x.test\nVikram Mehta,v@x.test\n',
      ['Asha Rao.pdf', 'Vikram Mehta.pdf'],
    );
    const r = await v1VerticalSuite.runExternal!({ externalSets: { 'v1-vertical': dir }, repoRoot: ROOT });
    assert.equal(r!.measures.find((x) => x.id.endsWith('wrong-pairings'))!.value, 2);
    assert.equal(r!.measures.find((x) => x.id.endsWith('pairing-precision'))!.value, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
