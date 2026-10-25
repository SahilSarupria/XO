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

export interface ReviewCandidate {
  readonly id: string;
  readonly split: 'dev' | 'held';
  readonly unitText: string;
  readonly candidate: string;
}
export interface ReviewGoldTerm {
  readonly split: 'dev' | 'held';
  readonly unitId: string;
  readonly unitText: string;
  readonly goldTerm: string;
  readonly ruleCovers: boolean;
  /** The model's accepted candidates for the same unit, shown to help answer "does a candidate you judged valid cover this term?". */
  readonly unitCandidates: readonly string[];
}

export interface KitCsvs {
  /** Structured copies of the two CSVs' rows, for the reviewer page. */
  readonly reviewCandidates: readonly ReviewCandidate[];
  readonly reviewGoldTerms: readonly ReviewGoldTerm[];
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
  const reviewCandidates: ReviewCandidate[] = [];
  const reviewGoldTerms: ReviewGoldTerm[] = [];
  items.forEach((it, i) => {
    modelCandidates[it.split] += 1;
    const id = `C${String(i + 1).padStart(3, '0')}`;
    reviewCandidates.push({ id, split: it.split, unitText: it.unitText, candidate: it.candidate });
    adjLines.push(csvLine([id, it.split, it.unitText, it.candidate, fill.verdict ? fill.verdict(i, it.split) : '']));
  });

  const goldTerms = { dev: 0, held: 0 };
  const ruleCovered = { dev: 0, held: 0 };
  const goldLines = [csvLine(GOLD_HEADER)];
  let g = 0;
  for (const [rowIndex, r] of rows.entries()) {
    const ruleLabels = r.ruleNodes.filter((n) => !n.isUnitPrimary).map((n) => n.label);
    for (const term of r.eval.entities) {
      const covered = ruleLabels.some((l) => strictMatch(l, term));
      reviewGoldTerms.push({
        split: r.eval.split,
        unitId: `${r.eval.file}: ${r.eval.textStart}`,
        unitText: r.unit.content,
        goldTerm: term,
        ruleCovers: covered,
        unitCandidates: [...(modelLabels[rowIndex] ?? [])],
      });
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
    reviewCandidates,
    reviewGoldTerms,
    adjudicationCsv: csvDoc(adjLines),
    shuffledFrom: items.map((it) => it.from),
    goldCsv: csvDoc(goldLines),
    stats: { modelCandidates, goldTerms, ruleCoveredGoldTerms: ruleCovered },
  };
}

/**
 * One self-contained, OFFLINE reviewer page (no network, no external script/style/font): the non-engineer's whole job. Part 1 is a
 * verdict per model candidate; Part 2 is yes/no per gold term. "Download my answers" saves the two CSVs (same columns as the kit) that
 * `score-adjudication.mjs` reads. Data is embedded as JSON with `<` escaped, and every dynamic string is inserted with textContent,
 * so document text can never be interpreted as markup or script. The page contains source document text: treat it like the CSVs.
 */
export function renderReviewHtml(kit: Pick<KitCsvs, 'reviewCandidates' | 'reviewGoldTerms'>): string {
  const data = JSON.stringify({ candidates: kit.reviewCandidates, gold: kit.reviewGoldTerms, verdicts: VERDICTS })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Candidate review</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#d0d0d0;--card:#f6f6f6;--ok:#0a7d33}
@media(prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--mut:#aaa;--line:#444;--card:#222;--ok:#5fd68a}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;margin:0 auto;max-width:56rem;padding:1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin:.75rem 0}
.unit{white-space:pre-wrap;color:var(--mut);max-height:9rem;overflow:auto;font-size:.9rem}
.cand{font-weight:600;margin:.4rem 0}
select{font:inherit;padding:.3rem;min-width:12rem}
.row-done{border-left:4px solid var(--ok)}
button{font:inherit;padding:.5rem 1rem;margin:.25rem .25rem .25rem 0;cursor:pointer}
.bar{position:sticky;top:0;background:var(--bg);padding:.5rem 0;border-bottom:1px solid var(--line)}
dt{font-weight:600}dd{margin:0 0 .4rem 0}
</style></head><body>
<h1>Review the model's suggestions</h1>
<p>You are checking whether each suggested term is a good knowledge term for the text shown. There are no right answers to look up: use your own judgement. Your answers stay in this page until you press <b>Download my answers</b>; nothing is sent anywhere.</p>
<details class="card" open><summary><b>What to choose in Part 1</b></summary><dl>
<dt>valid</dt><dd>A correct, useful term that is supported by the text (a party, organisation, place, defined term, named clause or category).</dd>
<dt>duplicate</dt><dd>Says the same thing as another suggestion for the same text.</dd>
<dt>unsupported</dt><dd>Not actually backed by the text, or wrong.</dd>
<dt>trivial</dt><dd>Technically fine but not worth keeping (a common word, a date, a number, a form label).</dd></dl></details>
<div class="bar"><span id="progress"></span> <button id="dl">Download my answers</button></div>
<h2>Part 1: judge each suggestion</h2><div id="p1"></div>
<h2>Part 2: is each expected term covered?</h2>
<p>For every expected term below, answer <b>yes</b> only if one of the suggestions you marked <b>valid</b> (listed under it) means the same thing. Otherwise answer <b>no</b>. If a term is already marked as found by the existing rules, you can still answer; it is scored separately.</p>
<div id="p2"></div>
<script id="data" type="application/json">${data}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent);
var V={},M={};
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}
function sel(opts,cur,on){var s=el('select');var b=el('option','', '- choose -');b.value='';s.appendChild(b);opts.forEach(function(o){var p=el('option','',o);p.value=o;s.appendChild(p)});s.value=cur||'';s.onchange=function(){on(s.value)};return s}
function progress(){var a=D.candidates.filter(function(c){return V[c.id]}).length,b=D.gold.filter(function(g,i){return M[i]}).length;
document.getElementById('progress').textContent='Part 1: '+a+'/'+D.candidates.length+' done. Part 2: '+b+'/'+D.gold.length+' done.'}
D.candidates.forEach(function(c){var card=el('div','card');card.appendChild(el('div','unit',c.unitText));card.appendChild(el('div','cand','Suggestion: '+c.candidate));
card.appendChild(sel(D.verdicts,'',function(v){V[c.id]=v;card.classList.toggle('row-done',!!v);progress()}));document.getElementById('p1').appendChild(card)});
D.gold.forEach(function(g,i){var card=el('div','card');card.appendChild(el('div','unit',g.unitText));card.appendChild(el('div','cand','Expected term: '+g.goldTerm));
var l=el('div','',g.unitCandidates.length?'Suggestions for this text: '+g.unitCandidates.join(' | '):'No suggestions were made for this text.');card.appendChild(l);
card.appendChild(sel(['yes','no'],'',function(v){M[i]=v;card.classList.toggle('row-done',!!v);progress()}));document.getElementById('p2').appendChild(card)});
function f(v){return /[",\\r\\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}
function csv(rows){return '\\uFEFF'+rows.map(function(r){return r.map(f).join(',')}).join('\\r\\n')+'\\r\\n'}
function save(name,text){var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));a.download=name;document.body.appendChild(a);a.click();a.remove()}
document.getElementById('dl').onclick=function(){
save('adjudication.csv',csv([['id','split','unit_text','candidate_text','verdict']].concat(D.candidates.map(function(c){return [c.id,c.split,c.unitText,c.candidate,V[c.id]||'']}))));
save('gold.csv',csv([['split','unit_id','gold_term','rule_covers','model_covers']].concat(D.gold.map(function(g,i){return [g.split,g.unitId,g.goldTerm,g.ruleCovers?'yes':'no',M[i]||'']}))))};
progress();
})();
</script></body></html>
`;
}
