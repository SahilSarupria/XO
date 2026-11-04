import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareQuality, measureCompile, meteredModel, type CompileQuality } from '../../src/policy/index.js';

// tests run from the compiled output, so resolve the corpus relative to the package root
const root = resolve(process.cwd(), 'test', 'corpus');
const baselinePath = join(root, 'baselines.json');
const files = existsSync(root)
  ? readdirSync(root)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .sort()
  : [];

test('corpus has manuals to guard', () => {
  assert.ok(files.length >= 4, `expected the seed corpus in ${root}`);
});

test('every corpus manual compiles with no regression against its stored baseline, within a latency ceiling', async () => {
  const update = process.env['UPDATE_CORPUS_BASELINE'] === '1';
  const stored: Record<string, CompileQuality> = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, CompileQuality>)
    : {};
  const next: Record<string, CompileQuality> = {};
  const problems: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    const { report } = await measureCompile(text, f.replace(/\.md$/, ''), f);
    next[f] = report.quality;
    if (report.compileMs > 5000) problems.push(`${f}: compile took ${report.compileMs}ms (ceiling 5000ms)`);
    const base = stored[f];
    if (base === undefined) {
      if (!update) problems.push(`${f}: no baseline (run with UPDATE_CORPUS_BASELINE=1 and commit it)`);
      continue;
    }
    for (const p of compareQuality(base, report.quality)) problems.push(`${f}: ${p}`);
  }
  if (update) writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n');
  else assert.deepEqual(problems, []);
});

test('metered model counts calls, failures, estimated tokens and cost only when prices are given', async () => {
  const m = meteredModel(async (p) => (p.includes('boom') ? Promise.reject(new Error('x')) : 'ok-reply'), { inPerMTok: 1, outPerMTok: 2 });
  await m.model('hello world');
  await assert.rejects(() => m.model('boom'));
  const u = m.usage();
  assert.equal(u.calls, 2);
  assert.equal(u.failures, 1);
  assert.equal(u.tokensAreEstimates, true);
  assert.ok(u.costUsd !== null && u.costUsd > 0);
  assert.equal(meteredModel(async () => '').usage().costUsd, null);
});

test('compareQuality flags a regression and ignores an improvement', () => {
  const base: CompileQuality = {
    decisionSentences: 10,
    understood: 8,
    understoodRatio: 0.8,
    unrecognized: 2,
    openQuestions: 3,
    blockingQuestions: 2,
    failClosedPaths: 0,
    treeProblems: 0,
    hasTree: true,
    rules: 8,
    inputs: 6,
  };
  assert.deepEqual(compareQuality(base, { ...base, understood: 9, understoodRatio: 0.9, blockingQuestions: 1 }), []);
  const worse = compareQuality(base, { ...base, understoodRatio: 0.5, hasTree: false, treeProblems: 2, blockingQuestions: 5, rules: 3 });
  assert.equal(worse.length, 5);
});
