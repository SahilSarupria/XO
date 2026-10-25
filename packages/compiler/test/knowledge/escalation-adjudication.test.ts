import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADJUDICATION_HEADER,
  GOLD_HEADER,
  VERDICTS,
  assertPureReplay,
  loadEvalRows,
  renderKit,
  runHybridOverRows,
  type KitRow,
} from './escalation-adjudication-kit.js';

/**
 * LOCAL ADJUDICATION KIT. Makes NO provider call, ever: every model answer is replayed from the durable cache written by the earlier
 * live run, through a fetch that THROWS, so any attempt to reach a provider is a hard failure and is counted.
 *
 * Opt-in (skipped unless BOTH are set):
 *   XO_EVAL_CACHE_DIR=<the cache directory the live run used>   XO_ADJUDICATION_OUT=<output directory>
 *   [XO_GEMINI_MODEL=<the model id the live run used, if it was not the default>]
 * Windows PowerShell example (from the repository root):
 *   $env:XO_EVAL_CACHE_DIR = "C:\path\to\cache"; $env:XO_ADJUDICATION_OUT = "$PWD\.eval-output\adjudication"
 *   cd packages\compiler; node --import tsx --test test\knowledge\escalation-adjudication.test.ts
 * Writes adjudication.csv (blank `verdict`) and gold.csv (blank `model_covers`); then score with
 *   node scripts/escalation-eval/score-adjudication.mjs <adjudication.csv> <gold.csv>
 *
 * The scripted-provider tests below prove the mechanics (zero provider calls on replay, deterministic shuffle, CSV shape, scorer
 * arithmetic, no text in the scorer outputs). Their numbers say NOTHING about real-model quality.
 */
const scorer = fileURLToPath(new URL('../../../../scripts/escalation-eval/score-adjudication.mjs', import.meta.url));

const throwingFetch = (async () => {
  throw new Error('provider call attempted during adjudication replay');
}) as typeof fetch;

/** Provider-less env: a placeholder key is enough because a replayed cache hit never reaches the provider. */
const replayEnv = (cacheDir: string, base: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => ({
  ...base,
  XO_INFERENCE_PROVIDER: base['XO_INFERENCE_PROVIDER'] ?? 'gemini',
  GEMINI_API_KEY: base['GEMINI_API_KEY'] ?? 'AIzaSyREPLAYONLY0123456789abcdefghijk',
  XO_COMPILER_MAX_TOTAL_TOKENS: base['XO_COMPILER_MAX_TOTAL_TOKENS'] ?? '1000000',
  XO_INFERENCE_CACHE_DIR: cacheDir,
});

const realCache = process.env['XO_EVAL_CACHE_DIR'];
const realOut = process.env['XO_ADJUDICATION_OUT'];

test(
  'REAL CACHE (opt-in): replay the live run from its cache with zero provider calls and write adjudication.csv + gold.csv',
  {
    skip: realCache && realOut ? false : 'set XO_EVAL_CACHE_DIR and XO_ADJUDICATION_OUT',
  },
  async () => {
    const rows = await loadEvalRows();
    const replay = await runHybridOverRows(rows, replayEnv(realCache!, process.env), throwingFetch);
    assertPureReplay(replay); // throws, content-free, if the cache does not fully cover the evaluation
    const kit = renderKit(rows, replay.modelLabels);
    await mkdir(realOut!, { recursive: true });
    await writeFile(join(realOut!, 'adjudication.csv'), kit.adjudicationCsv, 'utf8');
    await writeFile(join(realOut!, 'gold.csv'), kit.goldCsv, 'utf8');
    assert.equal(replay.fetchAttempts, 0);
    assert.equal(replay.report.providerCalls, 0);
  },
);

// ---- scripted-provider tests (plumbing only) --------------------------------------------------------------------------
/** A scripted Gemini fetch whose answers are grounded in the unit it is asked about (queue order == row order). */
function scriptedFetch(rows: readonly KitRow[], counter: { calls: number }): typeof fetch {
  const queue = rows.map((r) => r.unit.content);
  return (async () => {
    const i = counter.calls;
    counter.calls += 1;
    // Words the compile-side grounding check treats as content (it ignores a few stopwords); a scripted label built from one is always grounded.
    const stop = /^(shall|which|their|there|would|about|under|other|upon|these|those|being)$/i;
    const words = [...new Set((queue[i % queue.length] ?? '').match(/(?<![\w'-])[A-Za-z]{5,}(?![\w'-])/g) ?? [])].filter(
      (w) => !stop.test(w),
    );
    const items =
      i === 2 || words.length === 0
        ? [] // a valid zero-item answer (also used when a unit has no word the grounding check would accept)
        : [
            { id: 'i1', type: 'concept', statement: `${words[0]} noted`, domain: 'x', confidence: 0.8 },
            ...(words.length > 1 && i % 2 === 0
              ? [{ id: 'i2', type: 'concept', statement: `${words[1]} term`, domain: 'x', confidence: 0.8 }]
              : []),
          ];
    const body = {
      candidates: [{ content: { parts: [{ text: JSON.stringify({ items, relationships: [] }) }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

async function populatedKit() {
  const rows = await loadEvalRows();
  const dir = await mkdtemp(join(tmpdir(), 'xo-adjud-'));
  const env = replayEnv(dir, {});
  const counter = { calls: 0 };
  const live = await runHybridOverRows(rows, env, scriptedFetch(rows, counter));
  return { rows, dir, env, counter, live };
}

test('PLUMBING ONLY (scripted provider): replay uses the cache with ZERO provider calls and a deterministic, source-blind CSV', async () => {
  const { rows, dir, env, counter, live } = await populatedKit();
  try {
    assert.equal(counter.calls, rows.length, 'population: one scripted call per unit');
    assert.equal(live.report.providerCalls, rows.length);

    const replay = await runHybridOverRows(rows, env, throwingFetch);
    assertPureReplay(replay);
    assert.equal(replay.fetchAttempts, 0);
    assert.equal(replay.report.providerCalls, 0);
    assert.equal(counter.calls, rows.length, 'the replay made no further scripted call');
    assert.deepEqual(replay.modelLabels, live.modelLabels, 'replayed answers equal the generated ones');
    assert.equal(replay.report.outcomes.cache_hit, rows.length, 'every unit (even the zero-item one) is a cache hit');

    const a = renderKit(rows, replay.modelLabels);
    const b = renderKit(rows, replay.modelLabels);
    assert.equal(a.adjudicationCsv, b.adjudicationCsv, 'fixed seed: identical bytes on every run');
    assert.equal(a.goldCsv, b.goldCsv);

    const total = replay.modelLabels.reduce((n, l) => n + l.length, 0);
    const lines = a.adjudicationCsv.replace(/^\uFEFF/, '').split('\r\n');
    assert.equal(lines[0], ADJUDICATION_HEADER.join(','), 'no source, type, confidence or unit-id column');
    assert.equal(a.stats.modelCandidates.dev + a.stats.modelCandidates.held, total);
    assert.ok(a.adjudicationCsv.includes('C001,') && a.adjudicationCsv.includes(`C${String(total).padStart(3, '0')},`));
    // Shuffled with the fixed seed: a permutation of the original order, and not the identity.
    assert.deepEqual(
      [...a.shuffledFrom].sort((x, y) => x - y),
      Array.from({ length: total }, (_, i) => i),
    );
    assert.notDeepEqual(
      a.shuffledFrom,
      Array.from({ length: total }, (_, i) => i),
      'candidates are not left in unit order',
    );
    const goldLines = a.goldCsv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    assert.equal(goldLines[0], GOLD_HEADER.join(','));
    assert.equal(a.stats.goldTerms.dev, 46, 'gold totals unchanged: labels must not be edited');
    assert.equal(a.stats.goldTerms.held, 33);
    assert.ok(
      goldLines.slice(1).every((l) => /,(yes|no),$/.test(l)),
      'rule_covers is filled automatically, model_covers is blank',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('REPLAY refuses (content-free error) when the cache does not cover the evaluation, and never calls a provider', async () => {
  const rows = await loadEvalRows();
  const dir = await mkdtemp(join(tmpdir(), 'xo-adjud-empty-'));
  try {
    const replay = await runHybridOverRows(rows.slice(0, 3), replayEnv(dir, {}), throwingFetch);
    assert.ok(replay.fetchAttempts > 0, 'an empty cache forces the (throwing) fetch to be attempted');
    assert.equal(replay.report.providerCalls, 0, 'and nothing was obtained from a provider');
    assert.throws(
      () => assertPureReplay(replay),
      (e: Error) => /cache does not cover/.test(e.message) && !/noted|policy/i.test(e.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function runScorer(adj: string, gold: string, prefix: string) {
  return spawnSync(process.execPath, [scorer, adj, gold, prefix], { encoding: 'utf8' });
}

test('SCORER (scripted data): per-split arithmetic matches an independent computation, outputs hold no text', async () => {
  const { rows, dir, live } = await populatedKit();
  try {
    // Deterministic fill: cycle verdicts; model_covers "yes" for every third gold term that rules did not cover.
    const verdictAt = (i: number): string => VERDICTS[i % VERDICTS.length]!;
    const kitProbe = renderKit(rows, live.modelLabels);
    const ruleNo = kitProbe.goldCsv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
      .slice(1)
      .map((l) => /,no,$/.test(l));
    const modelCovers = (g: number): string => (ruleNo[g] && g % 3 === 0 ? 'yes' : 'no');
    const kit = renderKit(rows, live.modelLabels, { verdict: (i) => verdictAt(i), modelCovers: (g) => modelCovers(g) });
    const adjPath = join(dir, 'adjudication.csv');
    const goldPath = join(dir, 'gold.csv');
    await writeFile(adjPath, kit.adjudicationCsv, 'utf8');
    await writeFile(goldPath, kit.goldCsv, 'utf8');
    const prefix = join(dir, 'score');
    const run = runScorer(adjPath, goldPath, prefix);
    assert.equal(run.status, 0, run.stderr);
    const json = JSON.parse(await readFile(`${prefix}.json`, 'utf8')) as {
      complete: boolean;
      splits: Record<string, any>;
    };
    assert.equal(json.complete, true);

    // Independent expectation for each split, from the kit's own stats.
    for (const split of ['dev', 'held'] as const) {
      const s = json.splits[split];
      assert.equal(s.modelCandidates.total, kit.stats.modelCandidates[split]);
      assert.equal(s.modelCandidates.adjudicated, kit.stats.modelCandidates[split]);
      const sum = VERDICTS.reduce((n, v) => n + (s.modelCandidates.counts[v] as number), 0);
      assert.equal(sum, kit.stats.modelCandidates[split], 'verdict counts partition the candidates');
      assert.equal(s.goldTerms.total, kit.stats.goldTerms[split]);
      assert.equal(s.goldTerms.coveredByRules, kit.stats.ruleCoveredGoldTerms[split]);
      assert.ok(s.goldTerms.union >= s.goldTerms.coveredByRules);
      assert.ok(s.goldTerms.union <= s.goldTerms.total);
      assert.equal(s.strictRecall.rulesPlusValidModel, +(s.goldTerms.union / s.goldTerms.total).toFixed(3));
      assert.equal(
        s.validCandidatesPer100ModelCandidates,
        +((100 * s.modelCandidates.counts.valid) / s.modelCandidates.adjudicated).toFixed(1),
      );
    }
    // Pin the exact dev/held verdict counts: verdicts cycle by SHUFFLED row index, so the split counts are what the kit says they are.
    const adjRows = kit.adjudicationCsv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n')
      .slice(1);
    const expectValid = { dev: 0, held: 0 };
    adjRows.forEach((l, i) => {
      if (verdictAt(i) === 'valid') expectValid[/^C\d+,dev,/.test(l) ? 'dev' : 'held'] += 1;
    });
    assert.equal(json.splits['dev'].modelCandidates.counts.valid, expectValid.dev);
    assert.equal(json.splits['held'].modelCandidates.counts.valid, expectValid.held);

    // No text in the outputs: no unit text, candidate text or gold term, in JSON or markdown or the console.
    const secrets = [...new Set(rows.flatMap((r, i) => [...(live.modelLabels[i] ?? []), ...r.eval.entities.filter((e) => e.length > 4)]))];
    const outputs = [await readFile(`${prefix}.json`, 'utf8'), await readFile(`${prefix}.md`, 'utf8'), run.stdout, run.stderr].join('\n');
    for (const secret of secrets) assert.ok(!outputs.includes(secret), 'scorer output must contain aggregates only');
    assert.ok(!outputs.includes(rows[0]!.unit.content.slice(0, 30)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('SCORER: blank verdicts are PROVISIONAL, a bad verdict is rejected', async () => {
  const { rows, dir, live } = await populatedKit();
  try {
    const partial = renderKit(rows, live.modelLabels, { verdict: (i) => (i % 2 === 0 ? 'valid' : '') });
    await writeFile(join(dir, 'a.csv'), partial.adjudicationCsv, 'utf8');
    await writeFile(join(dir, 'g.csv'), partial.goldCsv, 'utf8');
    const run = runScorer(join(dir, 'a.csv'), join(dir, 'g.csv'), join(dir, 'p'));
    assert.equal(run.status, 0, run.stderr);
    const json = JSON.parse(await readFile(join(dir, 'p.json'), 'utf8')) as { complete: boolean; notes: string[] };
    assert.equal(json.complete, false);
    assert.ok(json.notes.some((n) => /PROVISIONAL/.test(n)));
    assert.match(await readFile(join(dir, 'p.md'), 'utf8'), /PROVISIONAL/);

    const bad = renderKit(rows, live.modelLabels, { verdict: () => 'great' });
    await writeFile(join(dir, 'b.csv'), bad.adjudicationCsv, 'utf8');
    const rejected = runScorer(join(dir, 'b.csv'), join(dir, 'g.csv'), join(dir, 'q'));
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /verdict must be one of valid \| duplicate \| unsupported \| trivial/);
    assert.ok(!/noted/.test(rejected.stderr), 'errors never echo candidate text');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
