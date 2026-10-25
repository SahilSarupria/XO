import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createCompilerAiLayer } from '@xo/ai-core';
import { createDefaultSourceFrontendRegistry } from '../../src/sources/default-registry.js';
import { chunkDocument } from '../../src/semantic/semantic-chunker.js';
import { RuleBasedKnowledgeExtractor } from '../../src/knowledge/rule-based-extractor.js';
import { AiKnowledgeExtractor } from '../../src/knowledge/ai-extractor.js';
import { HybridKnowledgeExtractor, type EscalationReport } from '../../src/knowledge/hybrid-extractor.js';
import type { CandidateKnowledgeNode } from '../../src/knowledge/extractor-types.js';
import type { ExperienceUnit } from '../../src/semantic/types.js';
import { EVAL_SET, type EvalUnit } from './escalation-eval-set.js';

/**
 * LOCAL ADJUDICATION KIT (no provider calls, ever): rebuilds the escalation eval units, replays every model answer from the durable
 * cache of an earlier live run, and renders two CSVs for a human adjudicator. The eval units, split and labels are NOT edited here.
 *
 * `loadEvalRows` is a deliberate copy of the loader in `escalation-eval.test.ts` (importing a `.test.ts` would register its tests, and
 * that file is pre-registered and must not be touched). The strict matcher is the same normalization as that file's `nrm`, but
 * STRICT: equality only, never the containment match the evaluation used (which favours verbose output).
 */
const dir = fileURLToPath(new URL('../../../../examples/vertical-test/', import.meta.url));
const FILES: Record<string, string> = {
  XO_Com: 'XO_Commercial_Property_Test_Policy_Compatible.pdf',
  burgla: 'burglary-policy.pdf',
  Aastha: 'Aastha.pdf',
};

export interface KitRow {
  readonly eval: EvalUnit;
  readonly unit: ExperienceUnit;
  readonly ruleNodes: readonly CandidateKnowledgeNode[];
}

export const VERDICTS = ['valid', 'duplicate', 'unsupported', 'trivial'] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Same normalization as the evaluation's `nrm` (lowercase, collapse whitespace, trim edge punctuation, drop a leading "the"). */
export const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .replace(/^the /, '');

/** STRICT match: the normalized candidate equals the normalized gold term. No containment. */
export const strictMatch = (candidate: string, gold: string): boolean => {
  const g = normalize(gold);
  return g.length > 0 && normalize(candidate) === g;
};

export async function loadEvalRows(): Promise<KitRow[]> {
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

export interface ReplayResult {
  /** Accepted model candidate labels per row (same order as the rows). Rejected or missing answers contribute nothing. */
  readonly modelLabels: readonly (readonly string[])[];
  readonly report: EscalationReport;
  /** Number of times the injected fetch was invoked (the only road to a provider). */
  readonly fetchAttempts: number;
}

/** Runs the default-policy hybrid extractor over every row with the given fetch. With a throwing fetch this is a pure cache replay. */
export async function runHybridOverRows(
  rows: readonly KitRow[],
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl: typeof fetch,
): Promise<ReplayResult> {
  let fetchAttempts = 0;
  const counted = (async (...args: Parameters<typeof fetch>) => {
    fetchAttempts += 1;
    return fetchImpl(...args);
  }) as typeof fetch;
  const resolution = createCompilerAiLayer(env, { fetchImpl: counted });
  if (resolution.state !== 'configured') throw new Error('no inference provider is configured (XO_INFERENCE_PROVIDER)');
  const hybrid = new HybridKnowledgeExtractor(new AiKnowledgeExtractor(resolution.aiCore));
  const modelLabels: string[][] = [];
  for (const r of rows) {
    const out = await hybrid.extract(r.unit);
    assert.ok(out.ok);
    modelLabels.push(out.ok ? out.value.nodes.filter((n) => n.extractorName === 'ai').map((n) => n.label) : []);
  }
  return { modelLabels, report: hybrid.report(), fetchAttempts };
}

/** Replay-only guarantee: fails (content-free message) unless every escalated unit came from the cache and no provider call was attempted. */
export function assertPureReplay(result: ReplayResult): void {
  const { report, fetchAttempts } = result;
  const missing = (report.outcomes.failed ?? 0) + (report.outcomes.denied ?? 0);
  if (fetchAttempts > 0 || report.providerCalls > 0 || missing > 0) {
    throw new Error(
      `the cache does not cover this evaluation: ${fetchAttempts} provider attempt(s) blocked, ${missing} unit(s) without a cached answer, ` +
        `${report.providerCalls} provider call(s) completed. Check XO_EVAL_CACHE_DIR, XO_GEMINI_MODEL and that the live run finished. Nothing was sent to a provider.`,
    );
  }
}

// ---- CSV -------------------------------------------------------------------------------------------------------------
const csvField = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvLine = (fields: readonly string[]): string => fields.map(csvField).join(',');
/** UTF-8 BOM so Excel on Windows reads non-ASCII text correctly; CRLF line endings. */
const csvDoc = (lines: readonly string[]): string => `﻿${lines.join('\r\n')}\r\n`;

/** Deterministic PRNG (mulberry32) so the shuffle is reproducible from the fixed seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const SHUFFLE_SEED = 20261025;

export interface KitCsvs {
  readonly adjudicationCsv: string;
  /** For tests: the pre-shuffle position of each rendered adjudication row (a permutation of 0..n-1). Never written to a file. */
  readonly shuffledFrom: readonly number[];
  readonly goldCsv: string;
  readonly stats: {
    readonly modelCandidates: Readonly<Record<'dev' | 'held', number>>;
    readonly goldTerms: Readonly<Record<'dev' | 'held', number>>;
    readonly ruleCoveredGoldTerms: Readonly<Record<'dev' | 'held', number>>;
  };
}

export const ADJUDICATION_HEADER = ['id', 'split', 'unit_text', 'candidate_text', 'verdict'] as const;
export const GOLD_HEADER = ['split', 'unit_id', 'gold_term', 'rule_covers', 'model_covers'] as const;

/**
 * Renders the two CSVs. adjudication.csv holds ONLY the model's accepted candidates, shuffled with a fixed seed and given opaque ids: no
 * source, type, confidence or unit grouping column, so the adjudicator sees only the unit text and the candidate. Rule coverage of gold
 * is decided mechanically (strict match) in gold.csv. `fill` is for tests only: it pre-fills verdicts / model_covers.
 */
export function renderKit(
  rows: readonly KitRow[],
  modelLabels: readonly (readonly string[])[],
  fill: {
    verdict?: (index: number, split: 'dev' | 'held') => string;
    modelCovers?: (index: number, split: 'dev' | 'held') => string;
  } = {},
): KitCsvs {
  assert.equal(rows.length, modelLabels.length);
  const items: { split: 'dev' | 'held'; unitText: string; candidate: string; from: number }[] = [];
  rows.forEach((r, i) => {
    for (const label of modelLabels[i] ?? [])
      items.push({ split: r.eval.split, unitText: r.unit.content, candidate: label, from: items.length });
  });
  const rand = mulberry32(SHUFFLE_SEED);
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  const modelCandidates = { dev: 0, held: 0 };
  const adjLines = [csvLine(ADJUDICATION_HEADER)];
  items.forEach((it, i) => {
    modelCandidates[it.split] += 1;
    adjLines.push(
      csvLine([`C${String(i + 1).padStart(3, '0')}`, it.split, it.unitText, it.candidate, fill.verdict ? fill.verdict(i, it.split) : '']),
    );
  });

  const goldTerms = { dev: 0, held: 0 };
  const ruleCovered = { dev: 0, held: 0 };
  const goldLines = [csvLine(GOLD_HEADER)];
  let g = 0;
  for (const r of rows) {
    const ruleLabels = r.ruleNodes.filter((n) => !n.isUnitPrimary).map((n) => n.label);
    for (const term of r.eval.entities) {
      const covered = ruleLabels.some((l) => strictMatch(l, term));
      goldTerms[r.eval.split] += 1;
      ruleCovered[r.eval.split] += covered ? 1 : 0;
      goldLines.push(
        csvLine([
          r.eval.split,
          `${r.eval.file}: ${r.eval.textStart}`,
          term,
          covered ? 'yes' : 'no',
          fill.modelCovers ? fill.modelCovers(g, r.eval.split) : '',
        ]),
      );
      g += 1;
    }
  }
  return {
    adjudicationCsv: csvDoc(adjLines),
    shuffledFrom: items.map((it) => it.from),
    goldCsv: csvDoc(goldLines),
    stats: { modelCandidates, goldTerms, ruleCoveredGoldTerms: ruleCovered },
  };
}
