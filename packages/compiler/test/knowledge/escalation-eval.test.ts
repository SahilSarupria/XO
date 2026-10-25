import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompilerAiLayer, estimateInputTokensUpperBound } from '@xo/ai-core';
import { createDefaultSourceFrontendRegistry } from '../../src/sources/default-registry.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { RuleBasedKnowledgeExtractor } from '../../src/knowledge/rule-based-extractor.js';
import { AiKnowledgeExtractor } from '../../src/knowledge/ai-extractor.js';
import { HybridKnowledgeExtractor, type EscalationReport } from '../../src/knowledge/hybrid-extractor.js';
import { DEFAULT_ESCALATION_POLICY, decideEscalation, isUsableLabel } from '../../src/knowledge/escalation-policy.js';
import type { CandidateKnowledgeNode } from '../../src/knowledge/extractor-types.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import { EVAL_SET, type EvalUnit } from './escalation-eval-set.js';

/**
 * ESCALATION POLICY EVALUATION (see `escalation-eval-set.ts` for how the labels were made).
 *
 * PRE-REGISTERED PROTOCOL (fixed before any real-model result exists; do not edit after seeing results):
 *   Matching (identical for rule and model candidates): a candidate label matches a gold term when, after lowercasing, collapsing
 *     whitespace, trimming edge punctuation and a leading "the", the two are equal OR the gold term appears in the label as a whole phrase.
 *     A candidate is a TRUE POSITIVE if it matches at least one gold term, otherwise a FALSE POSITIVE; a gold term is COVERED if any
 *     candidate matches it, otherwise MISSED. Precision = TP/candidates, recall = covered/gold, F1 harmonic mean, micro-averaged.
 *     Candidates are the rule entity candidates plus accepted model nodes; the always-present unit-primary node is excluded (it is the
 *     same in every strategy and labelled with the unit title).
 *   Calibration set: DEV only. Threshold grid: 0.60, 0.65, 0.70, 0.75, 0.85.
 *   Selection rule (dev only): the HIGHEST-SAVINGS threshold whose dev F1 is >= (always-escalate dev F1 - 0.02). If none saves at least 10%
 *     of always-escalate's model calls, the finding is "confidence-based skipping is not supported".
 *   Held-out: evaluated ONCE, for rules-only, always-escalate, gated at the default 0.75, and gated at the dev-selected threshold. No re-tuning.
 *   Support criterion for the default 0.75: held-out F1 >= always F1 - 0.02, AND held-out calls <= 0.90 x always calls, AND held-out F1 >
 *     rules-only F1 + 0.05 (the model must actually help), judged on REAL-MODEL results only.
 *
 * REAL-MODEL RUN is opt-in and refuses to start without a hard token budget. All strategies share ONE layer, ONE budget scope and ONE
 * durable cache, so a unit's model answer is generated at most once and replayed (uncharged) for every other strategy: differences between
 * strategies then isolate the gating decision, and real spend is bounded by roughly one call per unit.
 *   XO_LIVE_ESCALATION_EVAL=1  GEMINI_API_KEY=...  XO_INFERENCE_PROVIDER=gemini  XO_COMPILER_MAX_TOTAL_TOKENS=<hard cap>
 *   XO_EVAL_CACHE_DIR=<dir>  [XO_EVAL_PRICE_IN_PER_1K / XO_EVAL_PRICE_OUT_PER_1K for a cost estimate]  [XO_EVAL_REPORT_PATH=<file>]
 */
const dir = fileURLToPath(new URL('../../../../examples/vertical-test/', import.meta.url));
const FILES: Record<string, string> = {
  XO_Com: 'XO_Commercial_Property_Test_Policy_Compatible.pdf',
  burgla: 'burglary-policy.pdf',
  Aastha: 'Aastha.pdf',
};

const nrm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .replace(/^the /, '');
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (candidate: string, gold: string): boolean => {
  const c = nrm(candidate);
  const g = nrm(gold);
  return g.length > 0 && (c === g || new RegExp(`(^|[^a-z0-9])${esc(g)}([^a-z0-9]|$)`).test(c));
};

export interface Counts {
  candidates: number;
  tp: number;
  fp: number;
  gold: number;
  covered: number;
  missed: number;
}
const zero = (): Counts => ({ candidates: 0, tp: 0, fp: 0, gold: 0, covered: 0, missed: 0 });
export function scoreUnit(labels: readonly string[], gold: readonly string[]): Counts {
  const cands = [...new Set(labels.map(nrm).filter(Boolean))];
  const tp = cands.filter((c) => gold.some((g) => matches(c, g))).length;
  const covered = gold.filter((g) => cands.some((c) => matches(c, g))).length;
  return { candidates: cands.length, tp, fp: cands.length - tp, gold: gold.length, covered, missed: gold.length - covered };
}
const add = (a: Counts, b: Counts): Counts => ({
  candidates: a.candidates + b.candidates,
  tp: a.tp + b.tp,
  fp: a.fp + b.fp,
  gold: a.gold + b.gold,
  covered: a.covered + b.covered,
  missed: a.missed + b.missed,
});
export function prf(c: Counts): { precision: number; recall: number; f1: number } {
  const precision = c.candidates === 0 ? 0 : c.tp / c.candidates;
  const recall = c.gold === 0 ? 1 : c.covered / c.gold;
  return {
    precision: +precision.toFixed(3),
    recall: +recall.toFixed(3),
    f1: +(precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)).toFixed(3),
  };
}

interface Row {
  readonly eval: EvalUnit;
  readonly unit: ExperienceUnit;
  readonly ruleNodes: readonly CandidateKnowledgeNode[];
}

async function loadRows(): Promise<Row[]> {
  const registry = createDefaultSourceFrontendRegistry();
  const rb = new RuleBasedKnowledgeExtractor();
  const byFile = new Map<string, { unit: ExperienceUnit; nodes: CandidateKnowledgeNode[] }[]>();
  for (const [prefix, name] of Object.entries(FILES)) {
    const ing = registry.ingest({ kind: 'pdf', bytes: new Uint8Array(await readFile(dir + name)), sourcePath: name });
    assert.ok(ing.ok && ing.value.content.kind === 'document');
    if (!ing.ok || ing.value.content.kind !== 'document') continue;
    const doc = await chunkDocument(ing.value.content.parsed, name, ing.value.content.documentTitle);
    const list: { unit: ExperienceUnit; nodes: CandidateKnowledgeNode[] }[] = [];
    for (const unit of doc.units) {
      if (unit.isTableQuarantined) continue;
      const r = await rb.extract(unit);
      if (r.ok) list.push({ unit, nodes: [...r.value.nodes] });
    }
    byFile.set(prefix, list);
  }
  return EVAL_SET.map((e) => {
    const f = (byFile.get(e.file) ?? []).find((x) => x.unit.content.split(/\s+/).filter(Boolean).join(' ').slice(0, 50) === e.textStart);
    assert.ok(f, `eval unit not found: ${e.file} / ${e.textStart}`);
    return { eval: e, unit: f.unit, ruleNodes: f.nodes };
  });
}

const ruleLabels = (r: Row): string[] => r.ruleNodes.filter((n) => !n.isUnitPrimary).map((n) => n.label);
const sum = (rows: readonly Row[], labelsOf: (r: Row) => string[]): Counts =>
  rows.reduce((acc, r) => add(acc, scoreUnit(labelsOf(r), r.eval.entities)), zero());

// ---------------------------------------------------------------------------------------------------------------------
// A. MODEL-FREE (always runs): rule-only baseline and calibration of the rules' own confidence, on DEV for anything decision-relevant.
// ---------------------------------------------------------------------------------------------------------------------
test('eval set integrity: disjoint from the earlier gold, split fixed by hash, every unit resolvable', async () => {
  const { GOLD } = await import('./escalation-gold.js');
  const { createHash } = await import('node:crypto');
  const old = new Set(GOLD.map((g) => `${g.file}|${g.textStart}`));
  for (const e of EVAL_SET) {
    assert.ok(!old.has(`${e.file}|${e.textStart}`), `overlaps the earlier gold: ${e.textStart}`);
    const parity = Number(BigInt(`0x${createHash('sha256').update(`${e.file}|${e.textStart}`).digest('hex')}`) % 2n);
    assert.equal(e.split, parity === 0 ? 'dev' : 'held', `split must follow the pre-annotation hash rule: ${e.textStart}`);
  }
  const rows = await loadRows();
  assert.equal(rows.length, 43);
  assert.equal(rows.filter((r) => r.eval.split === 'dev').length, 21);
  assert.equal(rows.filter((r) => r.eval.split === 'held').length, 22);
});

test('MODEL-FREE: rule-only baseline, rule-confidence calibration (dev), and gate behaviour (dev)', async () => {
  const rows = await loadRows();
  const dev = rows.filter((r) => r.eval.split === 'dev');
  const held = rows.filter((r) => r.eval.split === 'held');

  // Rule-only baseline: deterministic, no model, no tuning. Held-out is reported once as a baseline, never used for a decision.
  const ruleOnly = { dev: sum(dev, ruleLabels), held: sum(held, ruleLabels) };

  // Calibration of the rules' own confidence against the labels, DEV only.
  const tiers: Record<string, { n: number; correct: number }> = {};
  const usability: Record<string, { n: number; correct: number }> = { usable: { n: 0, correct: 0 }, malformed: { n: 0, correct: 0 } };
  for (const r of dev) {
    for (const n of r.ruleNodes.filter((x) => !x.isUnitPrimary)) {
      const t = (tiers[String(n.confidence)] ??= { n: 0, correct: 0 });
      const ok = r.eval.entities.some((g) => matches(n.label, g));
      t.n += 1;
      t.correct += ok ? 1 : 0;
      const u = usability[isUsableLabel(n.label, DEFAULT_ESCALATION_POLICY.maxLabelWords) ? 'usable' : 'malformed']!;
      u.n += 1;
      u.correct += ok ? 1 : 0;
    }
  }
  const calibration = Object.fromEntries(
    Object.entries(tiers).map(([k, v]) => [
      k,
      { candidates: v.n, correct: v.correct, precision: v.n === 0 ? null : +(v.correct / v.n).toFixed(3) },
    ]),
  );

  // Gate behaviour on DEV: what each threshold escalates, and the error it leaves in SKIPPED units (rule output only; no model involved).
  const gateDev = [0.6, 0.65, 0.7, 0.75, 0.85].map((t) => {
    const policy = { ...DEFAULT_ESCALATION_POLICY, confidenceThreshold: t };
    const dec = dev.map((r) => ({ r, d: decideEscalation(r.unit, r.ruleNodes, policy) }));
    const skipped = dec.filter((x) => !x.d.escalate).map((x) => x.r);
    const left = sum(skipped, ruleLabels);
    return {
      threshold: t,
      escalated: dec.filter((x) => x.d.escalate).length,
      byReason: Object.fromEntries([...new Set(dec.map((x) => x.d.reason))].map((k) => [k, dec.filter((x) => x.d.reason === k).length])),
      goldInSkippedUnits: left.gold,
      missedInSkippedUnits: left.missed,
      falsePositivesInSkippedUnits: left.fp,
    };
  });

  // Competing candidates and fragments on the full eval set (diagnostic).
  const competing = rows.filter((r) => decideEscalation(r.unit, r.ruleNodes, DEFAULT_ESCALATION_POLICY).reason === 'ambiguous').length;
  const malformedAnywhere = rows.filter((r) =>
    r.ruleNodes.some((n) => !n.isUnitPrimary && !isUsableLabel(n.label, DEFAULT_ESCALATION_POLICY.maxLabelWords)),
  ).length;
  const budgetProxy = (rs: readonly Row[]): number =>
    rs.reduce((n, r) => n + estimateInputTokensUpperBound([{ content: r.unit.content }]), 0);

  const report = {
    ruleOnly: { dev: { ...ruleOnly.dev, ...prf(ruleOnly.dev) }, held: { ...ruleOnly.held, ...prf(ruleOnly.held) } },
    calibrationDev: { byConfidence: calibration, byUsability: usability },
    gateDev,
    competingUnitsAtDefault: competing,
    unitsWithMalformedCandidates: malformedAnywhere,
    inputTokenUpperBoundIfAlwaysEscalated: { dev: budgetProxy(dev), held: budgetProxy(held) },
  };
  if (process.env['XO_EVAL_REPORT_PATH']) await writeFile(process.env['XO_EVAL_REPORT_PATH'], JSON.stringify(report, null, 2));

  // Invariants only; no claim about improvement.
  assert.ok(ruleOnly.dev.gold === 46 && ruleOnly.held.gold === 33, 'gold totals changed: the labels must not be edited after results');
  for (const g of gateDev) assert.ok(g.escalated <= dev.length);
});

// ---------------------------------------------------------------------------------------------------------------------
// B. REAL-MODEL PROTOCOL (opt-in). Skipped without credentials + an explicit hard budget. Never substitutes an oracle.
// ---------------------------------------------------------------------------------------------------------------------
interface StrategyResult {
  readonly name: string;
  readonly counts: Counts;
  readonly prf: { precision: number; recall: number; f1: number };
  readonly escalated: number;
  readonly skipped: number;
  readonly freshModelCalls: number;
  readonly cacheReplays: number;
  readonly denied: number;
  readonly rejectedInvalid: number;
  readonly failed: number;
  readonly report: EscalationReport;
}

export async function runProtocol(
  rows: readonly Row[],
  env: Readonly<Record<string, string | undefined>>,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{
  results: Record<string, StrategyResult>;
  spend: { tokensSpent: number; costSpentUsd: number } | undefined;
  denials: object;
  estimatedCostUsd: number | 'unavailable';
}> {
  if (!env['XO_COMPILER_MAX_TOTAL_TOKENS'])
    throw new Error('refusing to run: set XO_COMPILER_MAX_TOTAL_TOKENS (a hard token budget) before any provider call');
  // Free-tier rate limits: optionally space out PROVIDER calls (cache replays make no call, so they are never delayed).
  const minIntervalMs = Number(env['XO_EVAL_MIN_INTERVAL_MS'] ?? 0);
  let lastCallAt = 0;
  const baseFetch = deps.fetchImpl ?? fetch;
  const pacedFetch = (async (...args: Parameters<typeof fetch>) => {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (minIntervalMs > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return baseFetch(...args);
  }) as typeof fetch;
  const resolution = createCompilerAiLayer(env, { ...deps, fetchImpl: pacedFetch });
  if (resolution.state !== 'configured') throw new Error('refusing to run: no inference provider is configured (XO_INFERENCE_PROVIDER)');
  const { aiCore } = resolution;

  const run = async (
    name: string,
    rs: readonly Row[],
    escalation: Parameters<typeof HybridKnowledgeExtractor.prototype.extract> extends never
      ? never
      : Partial<typeof DEFAULT_ESCALATION_POLICY>,
  ): Promise<StrategyResult> => {
    const hybrid = new HybridKnowledgeExtractor(new AiKnowledgeExtractor(aiCore), undefined, escalation);
    let counts = zero();
    for (const r of rs) {
      const out = await hybrid.extract(r.unit);
      assert.ok(out.ok);
      if (!out.ok) continue;
      counts = add(
        counts,
        scoreUnit(
          out.value.nodes.filter((n) => !n.isUnitPrimary).map((n) => n.label),
          r.eval.entities,
        ),
      );
    }
    const rep = hybrid.report();
    return {
      name,
      counts,
      prf: prf(counts),
      escalated: rep.escalated,
      skipped: rep.skipped,
      freshModelCalls: rep.outcomes.accepted ?? 0,
      cacheReplays: rep.outcomes.cache_hit ?? 0,
      denied: rep.outcomes.denied ?? 0,
      rejectedInvalid: rep.outcomes.rejected_invalid ?? 0,
      failed: rep.outcomes.failed ?? 0,
      report: rep,
    };
  };

  const dev = rows.filter((r) => r.eval.split === 'dev');
  const held = rows.filter((r) => r.eval.split === 'held');
  const results: Record<string, StrategyResult> = {};
  // Order matters: ALWAYS first, so every later strategy replays the same model answers from the shared cache.
  results['dev:always'] = await run('dev:always', dev, { mode: 'always' });
  results['dev:rules-only'] = {
    ...(await run('dev:rules-only', dev, { mode: 'gated', confidenceThreshold: 0, minContentWords: 1_000_000 })),
    name: 'dev:rules-only',
  };
  for (const t of [0.6, 0.65, 0.7, 0.75, 0.85])
    results[`dev:gated@${t}`] = await run(`dev:gated@${t}`, dev, { mode: 'gated', confidenceThreshold: t });

  // Pre-registered selection on DEV only.
  const alwaysF1 = results['dev:always']!.prf.f1;
  const alwaysCalls = results['dev:always']!.escalated;
  const eligible = [0.6, 0.65, 0.7, 0.75, 0.85]
    .filter((t) => results[`dev:gated@${t}`]!.prf.f1 >= alwaysF1 - 0.02)
    .sort((a, b) => results[`dev:gated@${a}`]!.escalated - results[`dev:gated@${b}`]!.escalated || b - a);
  const chosen = eligible.length > 0 && results[`dev:gated@${eligible[0]}`]!.escalated <= 0.9 * alwaysCalls ? eligible[0]! : undefined;

  // Held-out: ONCE.
  results['held:always'] = await run('held:always', held, { mode: 'always' });
  results['held:rules-only'] = await run('held:rules-only', held, { mode: 'gated', confidenceThreshold: 0, minContentWords: 1_000_000 });
  results['held:gated@0.75'] = await run('held:gated@0.75', held, { mode: 'gated', confidenceThreshold: 0.75 });
  if (chosen !== undefined && chosen !== 0.75)
    results[`held:gated@${chosen}(dev-selected)`] = await run(`held:gated@${chosen}`, held, { mode: 'gated', confidenceThreshold: chosen });

  const spend = aiCore.inferenceReport().spend;
  const pin = Number(env['XO_EVAL_PRICE_IN_PER_1K']);
  const pout = Number(env['XO_EVAL_PRICE_OUT_PER_1K']);
  return {
    results,
    chosenThreshold: chosen ?? null,
    scripted: deps.fetchImpl !== undefined,
    model: env['XO_GEMINI_MODEL'] ?? 'default (gemini-3.5-flash-lite)',
    spend,
    denials: aiCore.inferenceReport().denials,
    // Cost is only estimated from operator-supplied prices; the repository's pricing table has no verified entry for Gemini.
    estimatedCostUsd:
      spend && Number.isFinite(pin) && Number.isFinite(pout) ? +((spend.tokensSpent / 2 / 1000) * (pin + pout)).toFixed(4) : 'unavailable',
  };
}

const live =
  process.env['XO_LIVE_ESCALATION_EVAL'] === '1' &&
  Boolean(process.env['GEMINI_API_KEY']) &&
  Boolean(process.env['XO_COMPILER_MAX_TOTAL_TOKENS']);

test(
  'LIVE real-model protocol (opt-in; skipped without credentials AND an explicit hard budget)',
  {
    skip: live
      ? false
      : 'set XO_LIVE_ESCALATION_EVAL=1, GEMINI_API_KEY, XO_INFERENCE_PROVIDER=gemini, XO_COMPILER_MAX_TOTAL_TOKENS, XO_EVAL_CACHE_DIR',
  },
  async () => {
    const out = await runProtocol(await loadRows(), { ...process.env, XO_INFERENCE_CACHE_DIR: process.env['XO_EVAL_CACHE_DIR'] });
    if (process.env['XO_EVAL_REPORT_PATH']) await writeFile(process.env['XO_EVAL_REPORT_PATH'], JSON.stringify(out, null, 2));
    // No pass/fail on quality: the numbers are read against the pre-registered criteria in the header.
    assert.ok(Object.keys(out.results).length >= 8);
  },
);

// PLUMBING ONLY: a scripted provider proves the protocol's mechanics (shared budget, shared cache, order, hard-budget refusal).
// Its numbers say NOTHING about real-model quality and must never be reported as evidence for or against the gate.
test('PLUMBING ONLY (scripted provider, not real-model evidence): shared cache, hard budget, refusal without a budget', async () => {
  const rows = await loadRows();
  const queue = rows
    .filter((r) => r.eval.split === 'dev' && r.unit.content.split(/\s+/).filter(Boolean).length >= 4)
    .map((r) => r.unit.content);
  let call = 0;
  let fresh = 0;
  const fetchImpl = (async () => {
    const content = queue[call % queue.length] ?? '';
    call += 1;
    fresh += 1;
    const word = (content.match(/[A-Za-z]{5,}/g) ?? ['policy'])[0]!;
    const body = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  items: [{ id: 'i1', type: 'concept', statement: `${word} noted`, domain: 'x', confidence: 0.8 }],
                  relationships: [],
                }),
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 50, totalTokenCount: 250 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const dir2 = await mkdtemp(join(tmpdir(), 'xo-eval-'));
  try {
    const env = {
      XO_INFERENCE_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'AIzaSyPLUMBINGONLY0123456789abcdefghij',
      XO_COMPILER_MAX_TOTAL_TOKENS: '10000000',
      XO_INFERENCE_CACHE_DIR: dir2,
    };
    await assert.rejects(runProtocol(rows, { ...env, XO_COMPILER_MAX_TOTAL_TOKENS: undefined }, { fetchImpl }), /hard token budget/);
    assert.equal(fresh, 0, 'refusal must happen before any provider call');
    const out = await runProtocol(rows, env, { fetchImpl });
    // Optional: dump this SCRIPTED report so the results summarizer can be tested offline. It is not real-model evidence.
    if (process.env['XO_EVAL_PLUMBING_REPORT_PATH'])
      await writeFile(process.env['XO_EVAL_PLUMBING_REPORT_PATH'], JSON.stringify(out, null, 2));
    // Fresh provider calls happen ONLY in the two `always` arms (one per escalated unit, dev and held-out are different units); every
    // other arm (rules-only, all gated thresholds, the held-out gated arms) must replay the shared cache and never call again.
    const freshIn = (name: string): number => out.results[name]!.freshModelCalls + out.results[name]!.rejectedInvalid;
    assert.equal(fresh, freshIn('dev:always') + freshIn('held:always'), 'only the always arms may spend; gated arms reuse cached answers');
    assert.ok(out.results['dev:gated@0.75']!.cacheReplays + out.results['dev:gated@0.75']!.rejectedInvalid >= 0);
    assert.equal(out.results['dev:rules-only']!.escalated, 0);
    assert.ok(out.results['held:always'] && out.results['held:rules-only'] && out.results['held:gated@0.75']);
    assert.equal(out.estimatedCostUsd, 'unavailable', 'no prices supplied: cost must be reported unavailable, not invented');
  } finally {
    await rm(dir2, { recursive: true, force: true });
  }
});
