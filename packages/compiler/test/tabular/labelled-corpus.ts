/**
 * UW-3 — a seeded, labelled set of tables for measuring tabular ingestion. Every case states the right answer (header row or none,
 * each column's declared type, record count). It deliberately includes cases the heuristics are known to get wrong (numeric year
 * headers, text-only headerless lists), so the measurement reports real accuracy rather than a perfect score on easy input.
 *
 * This is synthetic: it measures the reader against what it was designed for. Accuracy on the owner's real documents is a separate,
 * labelled set (UW-13); no threshold is set here.
 */
import type { DeclaredType } from '../../src/tabular/types.js';
import { workbook, type TestCell, type TestSheet } from './workbook-builder.js';

export interface LabelledTable {
  readonly id: string;
  readonly category: 'clean' | 'titled' | 'typed-edge' | 'headerless' | 'known-hard';
  readonly format: 'xlsx' | 'csv';
  readonly bytesOrText: Uint8Array | string;
  /** Expected header row, or null when the table has none. */
  readonly headerRow: number | null;
  readonly types: readonly DeclaredType[];
  readonly records: number;
}

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type ColumnKind = 'name' | 'id0' | 'integer' | 'decimal' | 'date' | 'boolean' | 'mixed' | 'city';
const HEADERS: Record<ColumnKind, readonly string[]> = {
  name: ['Name', 'Client name', 'Customer', 'Employee'],
  id0: ['Account no', 'Client ID', 'Policy number', 'Branch code'],
  integer: ['Quantity', 'Units', 'Age', 'Count'],
  decimal: ['Premium', 'Amount', 'Balance', 'Rate'],
  date: ['Renewal date', 'Joined', 'Due date', 'Issued on'],
  boolean: ['Active', 'Verified', 'KYC done', 'Paid'],
  mixed: ['Score', 'Rating', 'Grade value', 'Points'],
  city: ['City', 'Branch', 'Region', 'State'],
};
const EXPECTED: Record<ColumnKind, DeclaredType> = {
  name: 'string',
  id0: 'string',
  integer: 'integer',
  decimal: 'decimal',
  date: 'date',
  boolean: 'boolean',
  mixed: 'mixed',
  city: 'string',
};
const NAMES = ['Asha Rao', 'Ravi Iyer', 'Meera Shah', 'Kabir Das', 'Zoya Khan', 'Arjun Nair', 'Isha Patel', 'Dev Menon'];
const CITIES = ['Pune', 'Mumbai', 'Chennai', 'Delhi', 'Kochi', 'Indore'];
const LETTERS = 'ABCDEFGHIJ';

function value(kind: ColumnKind, r: () => number, i: number, format: 'xlsx' | 'csv'): { csv: string; cell: TestCell } {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  switch (kind) {
    case 'name':
      return { csv: pick(NAMES), cell: { s: pick(NAMES) } };
    case 'city':
      return { csv: pick(CITIES), cell: { s: pick(CITIES) } };
    case 'id0': {
      const v = `00${100 + i}${Math.floor(r() * 9)}`;
      return { csv: v, cell: { s: v } };
    }
    case 'integer': {
      const v = 1 + Math.floor(r() * 500);
      return { csv: String(v), cell: { n: v } };
    }
    case 'decimal': {
      const v = (Math.floor(r() * 100000) / 100 + 0.01).toFixed(2);
      return { csv: v, cell: { n: v } };
    }
    case 'date': {
      const serial = 45200 + Math.floor(r() * 900);
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
      return { csv: d, cell: { n: serial, style: 2 } };
    }
    case 'boolean': {
      const b = r() < 0.5;
      return { csv: b ? 'true' : 'false', cell: { b } };
    }
    case 'mixed': {
      if (i % 3 === 1) return { csv: 'N/A', cell: { s: 'N/A' } };
      const v = 1 + Math.floor(r() * 9);
      return { csv: String(v), cell: { n: v } };
    }
  }
  void format;
}

function csvLine(cells: readonly string[]): string {
  return cells.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',');
}

function build(
  id: string,
  category: LabelledTable['category'],
  format: 'xlsx' | 'csv',
  kinds: readonly ColumnKind[],
  records: number,
  titles: readonly string[],
  r: () => number,
  opts: {
    headerless?: boolean;
    headerOverride?: readonly string[];
    expectHeaderRow?: number | null;
    expectTypes?: readonly DeclaredType[];
  } = {},
): LabelledTable {
  // A mixed column is a number on its first row and "N/A" on its second, so with a single record it is simply an integer column.
  const types = opts.expectTypes ?? kinds.map((k) => (k === 'mixed' && records < 2 ? 'integer' : EXPECTED[k]));
  const headers =
    opts.headerOverride ?? kinds.map((k, i) => `${HEADERS[k][Math.floor(r() * 4)]!}${kinds.indexOf(k) !== i ? ` ${i + 1}` : ''}`);
  const rows: { cells: readonly TestCell[]; csv: readonly string[] }[] = [];
  for (let i = 0; i < records; i++) {
    const vs = kinds.map((k) => value(k, r, i, format));
    rows.push({ cells: vs.map((v) => v.cell), csv: vs.map((v) => v.csv) });
  }
  const headerRow = opts.headerless === true ? null : titles.length + (titles.length > 0 ? 2 : 1);
  if (format === 'csv') {
    const lines: string[] = [];
    for (const t of titles) lines.push(t);
    if (titles.length > 0) lines.push('');
    if (opts.headerless !== true) lines.push(csvLine(headers));
    for (const row of rows) lines.push(csvLine(row.csv));
    return {
      id,
      category,
      format,
      bytesOrText: lines.join('\n'),
      headerRow: opts.expectHeaderRow !== undefined ? opts.expectHeaderRow : headerRow,
      types,
      records,
    };
  }
  const sheetRows: Record<number, Record<string, TestCell>> = {};
  let n = 1;
  for (const t of titles) sheetRows[n++] = { A: { s: t } };
  if (titles.length > 0) n++;
  if (opts.headerless !== true)
    sheetRows[n++] = Object.fromEntries(headers.map((h, i) => [LETTERS[i]!, /^\d+$/.test(h) ? { n: Number(h) } : { s: h }]));
  for (const row of rows) sheetRows[n++] = Object.fromEntries(row.cells.map((c, i) => [LETTERS[i]!, c]));
  const sheet: TestSheet = { name: 'Data', rows: sheetRows };
  return {
    id,
    category,
    format,
    bytesOrText: workbook([sheet]),
    headerRow: opts.expectHeaderRow !== undefined ? opts.expectHeaderRow : headerRow,
    types,
    records,
  };
}

export function labelledCorpus(seed = 20261113): LabelledTable[] {
  const r = prng(seed);
  const all: ColumnKind[] = ['name', 'id0', 'integer', 'decimal', 'date', 'boolean', 'mixed', 'city'];
  const pickKinds = (k: number): ColumnKind[] => {
    const pool = [...all];
    const out: ColumnKind[] = [];
    for (let i = 0; i < k; i++) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
    // tables lead with an identifying text column, as real registers do
    if (!out.includes('name')) out[0] = 'name';
    return out;
  };
  const cases: LabelledTable[] = [];
  for (let i = 0; i < 120; i++) {
    const format = i % 2 === 0 ? 'xlsx' : 'csv';
    const kinds = pickKinds(2 + Math.floor(r() * 6));
    const records = 1 + Math.floor(r() * 25);
    const titled = i % 3 === 0;
    cases.push(
      build(
        `t${i}`,
        titled ? 'titled' : 'clean',
        format,
        kinds,
        records,
        titled ? ['Client register', ...(i % 2 === 0 ? ['As at 31 March'] : [])] : [],
        r,
      ),
    );
  }
  // Typed edges: leading-zero ids, ISO dates in CSV, booleans, mixed columns, all present.
  for (let i = 0; i < 20; i++) {
    cases.push(
      build(`edge${i}`, 'typed-edge', i % 2 === 0 ? 'csv' : 'xlsx', ['name', 'id0', 'date', 'boolean', 'mixed'], 6 + (i % 5), [], r),
    );
  }
  // Headerless numeric tables: the right answer is "no header".
  for (let i = 0; i < 20; i++) {
    cases.push(
      build(`nohdr${i}`, 'headerless', i % 2 === 0 ? 'csv' : 'xlsx', ['integer', 'decimal', 'date'], 4 + (i % 6), [], r, {
        headerless: true,
      }),
    );
  }
  // Known hard: year headers stored as numbers (a real header the heuristic refuses), and headerless text lists (taken as headers).
  for (let i = 0; i < 5; i++) {
    cases.push(
      build(`years${i}`, 'known-hard', 'xlsx', ['name', 'decimal', 'decimal'], 5, [], r, {
        headerOverride: ['Particulars', '2024', '2025'],
      }),
    );
    cases.push(build(`textlist${i}`, 'known-hard', 'csv', ['name', 'city'], 6, [], r, { headerless: true }));
  }
  return cases;
}
