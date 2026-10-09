import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsoleLogger } from '@xo/logger';
import { run } from '../src/index.js';
import { benchmarkCompareCommand, benchmarkRunCommand } from '../src/commands/benchmark/benchmark.js';
import { withTempDir } from './helpers.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SUITES = join(REPO_ROOT, 'packages/benchmark/suites');
const BASELINES = join(REPO_ROOT, 'packages/benchmark/baselines');
const MECHANICS_SUITE = join(SUITES, 'runtime-mechanics.suite.json');
const MECHANICS_BASELINE = join(BASELINES, 'runtime-mechanics.report.json');
const FIXTURE = 'packages/benchmark/fixtures/xoir/runtime-mechanics.xoir.json';

async function mutatedRoot(dir: string): Promise<string> {
  const root = join(dir, 'mutated-root');
  await mkdir(join(root, dirname(FIXTURE)), { recursive: true });
  const graph = JSON.parse(await readFile(join(REPO_ROOT, FIXTURE), 'utf8')) as { edges: { id: string }[] };
  graph.edges = graph.edges.filter((e) => e.id !== 'edge_cap_bm_flow_b_requires_cap_bm_flow_a'); // the "compiler change"
  await writeFile(join(root, FIXTURE), JSON.stringify(graph));
  return root;
}

test('benchmark-run: runs a suite through the real pipeline, prints per-metric results, exits 0 (shortfalls against ground truth are measurements, not command failures)', async () => {
  const result = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, json: false, summaryOnly: true });
  assert.equal(result.exitCode, 0);
  const text = result.lines.join('\n');
  assert.match(text, /Benchmark suite "runtime-mechanics": 1 case\(s\), 1 evaluated, 0 harness error\(s\)/);
  assert.match(text, /workflowRecall\s+workflows\s+4\/4\s+100\.0%/);
  assert.match(text, /no combined score/);
  assert.doesNotMatch(text, /^case runtime-mechanics/m, '--summary omits per-case sections');
  const full = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, json: false, summaryOnly: false });
  assert.match(full.lines.join('\n'), /^case runtime-mechanics/m);
});

test('benchmark-run --out writes a report; --baseline against it reports NO_CHANGE and exits 0; --json is machine-readable', async () => {
  await withTempDir('xo-bm-cli-', async (dir) => {
    const out = join(dir, 'nested', 'report.json');
    const first = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, outPath: out, json: false, summaryOnly: true });
    assert.equal(first.exitCode, 0);
    assert.match(first.lines.join('\n'), /report written to/);
    const written = JSON.parse(await readFile(out, 'utf8')) as { suiteId: string; schemaVersion: number };
    assert.deepEqual([written.suiteId, written.schemaVersion], ['runtime-mechanics', 1]);
    // (P0.9C final closure) the accepted baseline was refreshed (Step 5-6 metrics included): it is exactly what the current pipeline produces.
    assert.equal(await readFile(out, 'utf8'), await readFile(MECHANICS_BASELINE, 'utf8'), 'the accepted baseline is exactly what the current pipeline produces');

    const again = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, baselinePath: out, json: false, summaryOnly: true });
    assert.equal(again.exitCode, 0);
    assert.match(again.lines.join('\n'), /Regression comparison for suite "runtime-mechanics": NO_CHANGE/);

    const json = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, baselinePath: out, json: true, summaryOnly: false });
    const parsed = JSON.parse(json.lines.join('\n')) as { report: { measured: boolean }; regression: { classification: string } };
    assert.equal(parsed.report.measured, true);
    assert.equal(parsed.regression.classification, 'no_change');
  });
});

test('benchmark-run --baseline exits 1 on a regression and names it (a "compiler change" that removes a precedence edge is caught)', async () => {
  await withTempDir('xo-bm-cli-regress-', async (dir) => {
    const root = await mutatedRoot(dir);
    const result = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, baselinePath: MECHANICS_BASELINE, sourceRoot: root, json: false, summaryOnly: true });
    assert.equal(result.exitCode, 1);
    const text = result.lines.join('\n');
    assert.match(text, /Regression comparison for suite "runtime-mechanics": REGRESSED/);
    assert.match(text, /workflowRecall regressed/);
    assert.match(text, /compilation output changed: yes/);
    assert.match(text, /\[compilation\]/);
    // Without a baseline the very same run is just a measurement: exit 0.
    const noBaseline = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, sourceRoot: root, json: false, summaryOnly: true });
    assert.equal(noBaseline.exitCode, 0);
  });
});

test('benchmark-run: invalid / unreadable inputs are clear failures (exit 1) with JSON paths — never a crash or a silent empty run', async () => {
  await withTempDir('xo-bm-cli-bad-', async (dir) => {
    const missing = await benchmarkRunCommand({ suitePath: join(dir, 'nope.json'), json: false, summaryOnly: false });
    assert.equal(missing.exitCode, 1);
    assert.match(missing.lines.join('\n'), /cannot read suite file/);

    await writeFile(join(dir, 'invalid.json'), JSON.stringify({ schemaVersion: 1, suiteId: 's', cases: [{ caseId: 'c', sources: [{ kind: 'nope', path: 'a' }], expect: {} }] }));
    const invalid = await benchmarkRunCommand({ suitePath: join(dir, 'invalid.json'), json: false, summaryOnly: false });
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.lines.join('\n'), /\$\.cases\[0\]\.sources\[0\]\.kind: must be one of/);

    const badBaseline = join(dir, 'baseline.json');
    await writeFile(badBaseline, JSON.stringify({ hello: 'world' }));
    const withBadBaseline = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, baselinePath: badBaseline, json: false, summaryOnly: false });
    assert.equal(withBadBaseline.exitCode, 1);
    assert.match(withBadBaseline.lines.join('\n'), /is not a benchmark report/);

    const noBaseline = await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, baselinePath: join(dir, 'gone.json'), json: false, summaryOnly: false });
    assert.equal(noBaseline.exitCode, 1);
    assert.match(noBaseline.lines.join('\n'), /cannot read report/);

    // A case the harness cannot run (missing source file) is exit 1 too — loudly not a pass.
    await writeFile(join(dir, 'harness.json'), JSON.stringify({ schemaVersion: 1, suiteId: 'h', cases: [{ caseId: 'c', sources: [{ kind: 'document', path: 'absent.txt' }], expect: {} }] }));
    const harness = await benchmarkRunCommand({ suitePath: join(dir, 'harness.json'), json: false, summaryOnly: false });
    assert.equal(harness.exitCode, 1);
    assert.match(harness.lines.join('\n'), /HARNESS ERROR/);
  });
});

test('benchmark-compare: two reports => NO_CHANGE (0) or a regression (1)', async () => {
  await withTempDir('xo-bm-cli-cmp-', async (dir) => {
    const same = await benchmarkCompareCommand({ baselinePath: MECHANICS_BASELINE, currentPath: MECHANICS_BASELINE, json: false });
    assert.equal(same.exitCode, 0);
    assert.match(same.lines.join('\n'), /NO_CHANGE/);

    const root = await mutatedRoot(dir);
    const regressedPath = join(dir, 'regressed.json');
    await benchmarkRunCommand({ suitePath: MECHANICS_SUITE, sourceRoot: root, outPath: regressedPath, json: false, summaryOnly: true });
    const regressed = await benchmarkCompareCommand({ baselinePath: MECHANICS_BASELINE, currentPath: regressedPath, json: true });
    assert.equal(regressed.exitCode, 1);
    const parsed = JSON.parse(regressed.lines.join('\n')) as { classification: string; regressions: { metricId: string }[] };
    assert.equal(parsed.classification, 'regressed');
    assert.ok(parsed.regressions.some((r) => r.metricId === 'workflowRecall'));
    // and the reverse direction is an improvement, not a regression
    const reverse = await benchmarkCompareCommand({ baselinePath: regressedPath, currentPath: MECHANICS_BASELINE, json: false });
    assert.equal(reverse.exitCode, 0);
    assert.match(reverse.lines.join('\n'), /IMPROVED/);

    const notAReport = join(dir, 'x.json');
    await writeFile(notAReport, '[]');
    assert.equal((await benchmarkCompareCommand({ baselinePath: notAReport, currentPath: MECHANICS_BASELINE, json: false })).exitCode, 1);
  });
});

test('the `benchmark-run` / `benchmark-compare` commands are registered in the CLI and print usage when called without arguments', async () => {
  const original = process.stdout.write;
  let captured = '';
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await run(['benchmark-run'], new ConsoleLogger({ level: 'error' })), 1);
    assert.match(captured, /xo benchmark-run <suite\.json>/);
    captured = '';
    assert.equal(await run(['benchmark-compare'], new ConsoleLogger({ level: 'error' })), 1);
    assert.match(captured, /xo benchmark-compare <baseline\.json> <current\.json>/);
    captured = '';
    assert.equal(await run([], new ConsoleLogger({ level: 'error' })), 0);
    assert.match(captured, /benchmark:/);
  } finally {
    process.stdout.write = original;
  }
});
