// UW-3 — measured accuracy of header detection, column typing and record counting on the labelled synthetic corpus. The numbers are
// pinned so any change is visible; they are a measurement, not an acceptance threshold (thresholds are the owner's, UW-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabularFromCsv, tabularFromXlsx } from '../../src/tabular/index.js';
import { labelledCorpus, type LabelledTable } from './labelled-corpus.js';

interface Tally {
  tables: number;
  headerRight: number;
  columns: number;
  typeRight: number;
  recordsRight: number;
}

function measure(cases: readonly LabelledTable[]): { overall: Tally; byCategory: Record<string, Tally>; misses: string[] } {
  const blank = (): Tally => ({ tables: 0, headerRight: 0, columns: 0, typeRight: 0, recordsRight: 0 });
  const overall = blank();
  const byCategory: Record<string, Tally> = {};
  const misses: string[] = [];
  for (const c of cases) {
    const t = c.format === 'csv' ? tabularFromCsv(c.bytesOrText as string) : tabularFromXlsx(c.bytesOrText as Uint8Array);
    assert.ok(t.ok, `${c.id}: ${t.ok ? '' : t.error.message}`);
    const set = t.value.recordSets[0]!;
    const cat = (byCategory[c.category] ??= blank());
    for (const tally of [overall, cat]) tally.tables++;
    const headerRight = (set.headerRow ?? null) === c.headerRow;
    const recordsRight = set.records.length === c.records;
    const types = set.columns.map((col) => col.declaredType);
    let right = 0;
    c.types.forEach((ty, i) => {
      if (types[i] === ty) right++;
    });
    for (const tally of [overall, cat]) {
      tally.headerRight += headerRight ? 1 : 0;
      tally.recordsRight += recordsRight ? 1 : 0;
      tally.columns += c.types.length;
      tally.typeRight += headerRight ? right : 0; // a wrong header shifts every column, so its types do not count as right
    }
    if (!headerRight || !recordsRight || right !== c.types.length) {
      misses.push(
        `${c.id} (${c.category}): header ${set.headerRow ?? 'none'} vs ${c.headerRow ?? 'none'}; types ${types.join('/')} vs ${c.types.join('/')}`,
      );
    }
  }
  return { overall, byCategory, misses };
}

const pct = (n: number, d: number) => Math.round((n / d) * 1000) / 10;

test('tabular accuracy on the labelled synthetic corpus (170 tables): measured, broken down, and pinned', (t) => {
  const { overall, byCategory, misses } = measure(labelledCorpus());
  const report = {
    tables: overall.tables,
    headerAccuracyPct: pct(overall.headerRight, overall.tables),
    columnTypeAccuracyPct: pct(overall.typeRight, overall.columns),
    recordCountAccuracyPct: pct(overall.recordsRight, overall.tables),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [
        k,
        { tables: v.tables, headerPct: pct(v.headerRight, v.tables), typePct: pct(v.typeRight, v.columns) },
      ]),
    ),
  };
  t.diagnostic(JSON.stringify(report));
  for (const m of misses) t.diagnostic(`miss: ${m}`);
  // Everything the reader is designed for is read exactly; the misses are the known-hard cases, by design of the corpus.
  for (const k of ['clean', 'titled', 'typed-edge', 'headerless'] as const) {
    assert.equal(report.byCategory[k]?.headerPct, 100, `${k}: ${misses.filter((m) => m.includes(`(${k})`)).join(' | ')}`);
    assert.equal(report.byCategory[k]?.typePct, 100, `${k}: ${misses.filter((m) => m.includes(`(${k})`)).join(' | ')}`);
  }
  // Year headings are read since UW-3's heuristic for them; a headerless text-only list is still taken as headed (a known limit: no
  // reader can tell "Asha, Pune" from "Name, City" without knowing names).
  assert.equal(report.byCategory['known-hard']?.headerPct, 50);
  assert.equal(report.tables, 170);
  assert.equal(misses.length, 5);
  assert.ok(misses.every((m) => m.startsWith('textlist')));
});
