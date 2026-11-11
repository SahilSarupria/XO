#!/usr/bin/env node
// Scores a human-adjudicated escalation kit. Usage:
//   node score-adjudication.mjs <adjudication.csv> <gold.csv> [outPrefix]
// Reads the two CSVs written by packages/compiler/test/knowledge/escalation-adjudication.test.ts (after a person filled the `verdict`
// column and the `model_covers` column) and writes <outPrefix>.json and <outPrefix>.md (default: next to adjudication.csv, named
// adjudication-score). AGGREGATES ONLY: no unit text, candidate text or gold terms are ever written to the outputs or the console.
//
// Per split (dev / held, never mixed):
//   - model candidates: count and % valid / duplicate / unsupported / trivial (of the adjudicated rows)
//   - gold terms covered by rules (strict match, automatic) vs by a VALID model candidate (model_covers, by hand) vs the union
//   - strict recall: rules vs rules + valid model
//   - valid candidates per 100 model candidates, and newly covered gold terms per 100 model candidates
// Do not tune anything on the held-out split.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const VERDICTS = ['valid', 'duplicate', 'unsupported', 'trivial'];
const SPLITS = ['dev', 'held'];

const [, , adjPath, goldPath, outPrefixArg] = process.argv;
if (!adjPath || !goldPath) {
  console.error('usage: node score-adjudication.mjs <adjudication.csv> <gold.csv> [outPrefix]');
  process.exit(2);
}
const fail = (msg) => {
  console.error(`score-adjudication: ${msg}`);
  process.exit(2);
};

/** RFC 4180 parser: quoted fields, "" escapes, embedded CR/LF, optional UTF-8 BOM. Returns rows of strings. */
function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') endField();
    else if (c === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRow();
    } else if (c === '\n') endRow();
    else field += c;
    i += 1;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

function readTable(path, label, required) {
  let rows;
  try {
    rows = parseCsv(readFileSync(path, 'utf8'));
  } catch (e) {
    fail(`cannot read ${label} "${path}": ${e.message}`);
  }
  if (rows.length === 0) fail(`${label} is empty`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = {};
  for (const col of required) {
    const k = header.indexOf(col);
    if (k < 0) fail(`${label} is missing the column "${col}" (found: ${header.join(', ')})`);
    idx[col] = k;
  }
  const out = rows.slice(1).map((r, n) => {
    const rec = {};
    for (const col of required) rec[col] = (r[idx[col]] ?? '').trim();
    rec._line = n + 2;
    return rec;
  });
  return out;
}

const adj = readTable(adjPath, 'adjudication.csv', ['id', 'split', 'verdict']);
const gold = readTable(goldPath, 'gold.csv', ['split', 'unit_id', 'rule_covers', 'model_covers']);

const seen = new Set();
for (const r of adj) {
  if (!SPLITS.includes(r.split.toLowerCase())) fail(`adjudication.csv line ${r._line}: split must be dev or held`);
  r.split = r.split.toLowerCase();
  if (seen.has(r.id)) fail(`adjudication.csv line ${r._line}: duplicate id`);
  seen.add(r.id);
  const v = r.verdict.toLowerCase();
  if (v !== '' && !VERDICTS.includes(v))
    fail(`adjudication.csv line ${r._line}: verdict must be one of ${VERDICTS.join(' | ')} (or blank = not yet adjudicated)`);
  r.verdict = v;
}
const yesNo = (v, line, col, allowBlank) => {
  const s = v.toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(s)) return true;
  if (['no', 'n', 'false', '0'].includes(s)) return false;
  if (s === '' && allowBlank) return null;
  fail(`gold.csv line ${line}: ${col} must be yes or no${allowBlank ? ' (or blank = not yet judged)' : ''}`);
};
for (const g of gold) {
  if (!SPLITS.includes(g.split.toLowerCase())) fail(`gold.csv line ${g._line}: split must be dev or held`);
  g.split = g.split.toLowerCase();
  g.rule = yesNo(g.rule_covers, g._line, 'rule_covers', false);
  g.model = yesNo(g.model_covers, g._line, 'model_covers', true);
}

const pct = (n, d) => (d === 0 ? null : +((100 * n) / d).toFixed(1));
const ratio = (n, d) => (d === 0 ? null : +(n / d).toFixed(3));
const result = { complete: true, splits: {}, notes: [] };

for (const split of SPLITS) {
  const rows = adj.filter((r) => r.split === split);
  const judged = rows.filter((r) => r.verdict !== '');
  const counts = Object.fromEntries(VERDICTS.map((v) => [v, judged.filter((r) => r.verdict === v).length]));
  const terms = gold.filter((g) => g.split === split);
  const byRules = terms.filter((g) => g.rule).length;
  const pending = terms.filter((g) => g.model === null).length;
  const byModel = terms.filter((g) => g.model === true).length;
  const union = terms.filter((g) => g.rule || g.model === true).length;
  const inconsistent = byModel > 0 && counts.valid === 0;
  const complete = judged.length === rows.length && pending === 0;
  if (!complete) result.complete = false;
  result.splits[split] = {
    modelCandidates: {
      total: rows.length,
      adjudicated: judged.length,
      unadjudicated: rows.length - judged.length,
      counts,
      percentOfAdjudicated: Object.fromEntries(VERDICTS.map((v) => [v, pct(counts[v], judged.length)])),
    },
    goldTerms: {
      total: terms.length,
      coveredByRules: byRules,
      coveredByValidModel: byModel,
      union,
      modelCoversPending: pending,
    },
    strictRecall: {
      rules: ratio(byRules, terms.length),
      rulesPlusValidModel: ratio(union, terms.length),
      gain: terms.length === 0 ? null : +((union - byRules) / terms.length).toFixed(3),
    },
    validCandidatesPer100ModelCandidates: pct(counts.valid, judged.length),
    newGoldTermsCoveredPer100ModelCandidates: judged.length === 0 ? null : +((100 * (union - byRules)) / judged.length).toFixed(1),
    complete,
    inconsistentModelCoversWithoutValidCandidates: inconsistent,
  };
}
if (!result.complete)
  result.notes.push('PROVISIONAL: some verdicts or model_covers cells are still blank; the figures cover only what has been judged.');
for (const split of SPLITS)
  if (result.splits[split].inconsistentModelCoversWithoutValidCandidates)
    result.notes.push(`${split}: model_covers has "yes" cells but no candidate was judged valid; check the adjudication.`);
result.notes.push(
  'This is candidate-quality evidence only. It does not evaluate the pre-registered gating criteria: confidence gating stays NOT SUPPORTED.',
);
result.notes.push('Single run, small set, adjudicator verdicts only as good as the adjudicator. Do not tune on the held-out split.');

// ---- markdown (numbers only) -----------------------------------------------------------------------------------------
const f = (v, suffix = '') => (v === null ? 'n/a' : `${v}${suffix}`);
const md = [];
md.push('# Escalation adjudication score (aggregates only)');
md.push('');
if (!result.complete) md.push('> **PROVISIONAL**: some verdicts or `model_covers` cells are still blank.\n');
md.push(
  "Strict recall uses an equality match (normalized), not the containment match of the original evaluation. The adjudicator should be someone other than the gate's author. Do not tune on the held-out split.",
);
md.push('');
md.push('## Model candidates');
md.push('');
md.push('| Split | Candidates | Adjudicated | valid | duplicate | unsupported | trivial |');
md.push('|---|---|---|---|---|---|---|');
for (const s of SPLITS) {
  const m = result.splits[s].modelCandidates;
  const p = m.percentOfAdjudicated;
  md.push(
    `| ${s} | ${m.total} | ${m.adjudicated} | ${m.counts.valid} (${f(p.valid, '%')}) | ${m.counts.duplicate} (${f(p.duplicate, '%')}) | ${m.counts.unsupported} (${f(p.unsupported, '%')}) | ${m.counts.trivial} (${f(p.trivial, '%')}) |`,
  );
}
md.push('');
md.push('## Gold-term coverage (strict)');
md.push('');
md.push('| Split | Gold terms | By rules | By valid model | Union | Recall rules | Recall rules + valid model | Gain |');
md.push('|---|---|---|---|---|---|---|---|');
for (const s of SPLITS) {
  const g = result.splits[s].goldTerms;
  const r = result.splits[s].strictRecall;
  md.push(
    `| ${s} | ${g.total} | ${g.coveredByRules} | ${g.coveredByValidModel} | ${g.union} | ${f(r.rules)} | ${f(r.rulesPlusValidModel)} | ${f(r.gain)} |`,
  );
}
md.push('');
md.push('## Yield per 100 model candidates');
md.push('');
md.push('| Split | Valid candidates | Newly covered gold terms |');
md.push('|---|---|---|');
for (const s of SPLITS) {
  const x = result.splits[s];
  md.push(`| ${s} | ${f(x.validCandidatesPer100ModelCandidates)} | ${f(x.newGoldTermsCoveredPer100ModelCandidates)} |`);
}
md.push('');
for (const n of result.notes) md.push(`- ${n}`);
md.push('');

const prefix = outPrefixArg ?? join(dirname(adjPath), 'adjudication-score');
writeFileSync(`${prefix}.json`, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(`${prefix}.md`, md.join('\n'));
console.log(md.join('\n'));
console.log(`\nWrote ${prefix}.json and ${prefix}.md`);
