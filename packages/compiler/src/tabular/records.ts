/**
 * From a sheet grid to record sets (UW-3): regions, title lines, header detection, declared column types, records.
 *
 * Regions: a run of two or more blank rows ends a table; whatever follows is another table. A single blank row stays inside a table.
 *
 * Header: within the first rows of a region, the first row that (1) is wide enough (at least 60% of the region's usual row width, and two
 * cells unless the table has one column), (2) holds only text, (3) is mostly distinct and (4) has data below it. Single-cell rows above it
 * are titles. If no row qualifies the table is kept with columns named by letter and a HEADER_NOT_FOUND finding: a guessed header would
 * mislabel every value under it.
 *
 * Types: each value is classed from what was stored (workbook cells) or what was written (CSV text). A column's declared type is the one
 * class its values share (integers and decimals together are `decimal`), otherwise `mixed`. Values are never converted.
 */
import { columnLetter, cellRef } from './refs.js';
import { TABULAR_LIMITS } from './limits.js';
import type { DeclaredType, RecordSet, SheetGrid, TabularCell, TabularColumn, TabularFinding, TabularRecord, ValueClass } from './types.js';

type Row = SheetGrid['rows'][number];

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.\d*|\.\d+|\d+(?:\.\d+)?[eE][+-]?\d+)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASHED_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
const SEPARATED_NUMBER = /^[+-]?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?$/;

function validIsoDate(text: string): boolean {
  const m = ISO_DATE.exec(text);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The class of one value. Workbook cells are classed by how they were stored; text (CSV, or text cells) by what it looks like. */
export function classify(cell: TabularCell, fromText: boolean): ValueClass {
  if (cell.kind === 'boolean') return 'boolean';
  if (cell.kind === 'error') return 'error';
  if (cell.kind === 'date') return 'date';
  if (cell.kind === 'number') return INTEGER.test(cell.raw) ? 'integer' : 'decimal';
  if (!fromText) return 'string';
  const t = cell.raw.trim();
  if (INTEGER.test(t)) return /^[+-]?0\d/.test(t) ? 'string' : 'integer'; // leading zeros: an identifier, not a number
  if (DECIMAL.test(t)) return 'decimal';
  if (/^(true|false)$/i.test(t)) return 'boolean';
  if (validIsoDate(t)) return 'date';
  return 'string';
}

function declare(counts: Partial<Record<ValueClass, number>>): DeclaredType {
  const present = (Object.keys(counts) as ValueClass[]).filter((k) => (counts[k] ?? 0) > 0);
  if (present.length === 0) return 'empty';
  if (present.length === 1) return present[0]!;
  if (present.length === 2 && present.includes('integer') && present.includes('decimal')) return 'decimal';
  return 'mixed';
}

/** Splits rows into regions at runs of two or more blank rows. */
function regions(rows: readonly Row[]): Row[][] {
  const out: Row[][] = [];
  let current: Row[] = [];
  let last = -10;
  for (const r of rows) {
    if (current.length > 0 && r.row - last > 2) {
      out.push(current);
      current = [];
    }
    current.push(r);
    last = r.row;
  }
  if (current.length > 0) out.push(current);
  return out;
}

function modalWidth(rows: readonly Row[]): number {
  const freq = new Map<number, number>();
  for (const r of rows) freq.set(r.cells.length, (freq.get(r.cells.length) ?? 0) + 1);
  let width = 0;
  let best = 0;
  for (const [w, f] of freq) if (f > best || (f === best && w > width)) [width, best] = [w, f];
  return width;
}

function inMerge(merges: readonly string[], ref: string): string | undefined {
  const at = /([A-Z]+\d+)$/.exec(ref)?.[1];
  if (at === undefined) return undefined;
  const p = /^([A-Z]+)(\d+)$/.exec(at)!;
  const col = [...p[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const row = Number(p[2]);
  for (const m of merges) {
    const [a, b] = m.split(':');
    const pa = /^([A-Z]+)(\d+)$/.exec(a ?? '');
    const pb = /^([A-Z]+)(\d+)$/.exec(b ?? '');
    if (pa === null || pb === null) continue;
    const c1 = [...pa[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    const c2 = [...pb[1]!].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    if (col >= c1 && col <= c2 && row >= Number(pa[2]) && row <= Number(pb[2])) return m;
  }
  return undefined;
}

/** A range with its sheet, quoted the way `cellRef` quotes it: `Clients!A2:A3`. */
function qualify(sheet: string | undefined, range: string): string {
  if (sheet === undefined) return range;
  const prefix = cellRef(sheet, 1, 1).slice(0, -2); // "Clients!" or "'My sheet'!"
  return `${prefix}${range}`;
}

function isYearHeader(cell: TabularCell, below: readonly Row[]): boolean {
  const raw = cell.raw.trim();
  const year = /^\d{4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(year >= 1900 && year <= 2100) || (cell.kind !== 'number' && cell.kind !== 'string')) return false;
  const values = below.flatMap((b) => b.cells.filter((c) => c.column === cell.column));
  return values.length > 0 && !values.every((c) => /^\d{4}$/.test(c.raw.trim()) && Number(c.raw) >= 1900 && Number(c.raw) <= 2100);
}

export interface RecordSetOptions {
  /** True for CSV: values are text, so their class comes from what they look like. */
  readonly fromText: boolean;
}

export function recordSetsFromGrid(grid: SheetGrid, options: RecordSetOptions): RecordSet[] {
  const sets: RecordSet[] = [];
  for (const [i, region] of regions(grid.rows).entries()) {
    sets.push(recordSetFromRegion(grid, region, `${grid.name ?? ''}#${i + 1}`, options));
  }
  return sets;
}

function recordSetFromRegion(grid: SheetGrid, region: readonly Row[], id: string, options: RecordSetOptions): RecordSet {
  const findings: TabularFinding[] = [];
  const width = modalWidth(region);
  const minWidth = width <= 1 ? 1 : Math.max(2, Math.ceil(width * 0.6));
  let headerIndex = -1;
  let evidence = '';
  // A table that is only a row of distinct text is a header with no records yet (an empty template), not one record.
  if (region.length === 1) {
    const only = region[0]!;
    const texts = only.cells.map((c) => c.raw.trim().toLowerCase());
    if (
      only.cells.length >= 2 &&
      only.cells.every((c) => c.kind === 'string' && classify(c, true) === 'string') &&
      new Set(texts).size === texts.length
    ) {
      headerIndex = 0;
      evidence = `row ${only.row} is the only row and holds distinct text values: a header with no records`;
    }
  }
  const scan = headerIndex >= 0 ? 0 : Math.min(region.length - 1, TABULAR_LIMITS.headerScanRows);
  for (let i = 0; i < scan; i++) {
    const r = region[i]!;
    if (r.cells.length < minWidth) continue;
    const below = region.slice(i + 1);
    // Year headers (Particulars | 2024 | 2025), common in financial schedules: a whole-number cell from 1900 to 2100 counts as header text
    // when the row also has text and the values under that column are not themselves years.
    const yearHeaders = r.cells.filter((c) => isYearHeader(c, below));
    const headerLike = (c: TabularCell) => (c.kind === 'string' && classify(c, true) === 'string') || yearHeaders.includes(c);
    if (!r.cells.every(headerLike)) continue;
    if (yearHeaders.length > 0 && !r.cells.some((c) => c.kind === 'string' && classify(c, true) === 'string')) continue;
    const texts = r.cells.map((c) => c.raw.trim().toLowerCase());
    if (new Set(texts).size < Math.ceil(texts.length * 0.8)) continue;
    // The rows below must not all be text rows of the same shape that would equally qualify (then the first of them is the header only
    // if something below is not text, or the table is text-only and this row is its first full-width row).
    const belowHasNonText = below.some((b) => b.cells.some((c) => classify(c, options.fromText) !== 'string'));
    headerIndex = i;
    evidence = belowHasNonText
      ? `row ${r.row} is the first row of ${r.cells.length} distinct text values with typed data below it`
      : `row ${r.row} is the first full-width row of distinct text values (every value in this table is text)`;
    if (yearHeaders.length > 0) evidence += `; ${yearHeaders.map((c) => c.raw).join(', ')} read as year headings`;
    break;
  }

  const titles: TabularCell[] = [];
  let headerRow: Row | undefined;
  let dataRows: readonly Row[];
  if (headerIndex >= 0) {
    headerRow = region[headerIndex]!;
    for (const r of region.slice(0, headerIndex)) titles.push(...r.cells);
    dataRows = region.slice(headerIndex + 1);
    if (titles.length > 0) {
      findings.push({
        code: 'TITLE_ROWS',
        ref: titles[0]!.ref,
        message: `${headerIndex} row(s) above the header were kept as titles, not data`,
      });
    }
  } else {
    dataRows = region;
    const first = region[0]?.cells[0]?.ref;
    findings.push({
      code: 'HEADER_NOT_FOUND',
      ...(first !== undefined ? { ref: first } : {}),
      message: 'no row looks like a header (wide enough, all distinct text, data below), so columns are named by letter',
    });
  }

  // Columns: every column that holds a header or a value.
  const columnNumbers = new Set<number>();
  for (const r of dataRows) for (const c of r.cells) columnNumbers.add(c.column);
  const headerByColumn = new Map<number, TabularCell>();
  for (const c of headerRow?.cells ?? []) {
    headerByColumn.set(c.column, c);
    columnNumbers.add(c.column);
  }
  const columnList = [...columnNumbers].sort((a, b) => a - b);

  if (headerRow !== undefined) {
    const span = { min: Math.min(...headerByColumn.keys()), max: Math.max(...headerByColumn.keys()) };
    for (let col = span.min; col <= span.max; col++) {
      if (!headerByColumn.has(col) && columnNumbers.has(col)) {
        findings.push({
          code: 'EMPTY_HEADER',
          ref: cellRef(grid.name, col, headerRow.row),
          message: `column ${columnLetter(col)} has values but no header`,
        });
      }
    }
    const outside = columnList.filter((col) => col < span.min || col > span.max);
    if (outside.length > 0) {
      findings.push({
        code: 'VALUES_OUTSIDE_HEADER',
        ref: cellRef(grid.name, outside[0]!, headerRow.row),
        message: `column(s) ${outside.map(columnLetter).join(', ')} hold values outside the header's columns`,
      });
    }
    const seen = new Map<string, string>();
    for (const c of headerRow.cells) {
      const key = c.raw.trim().toLowerCase();
      const first = seen.get(key);
      if (first !== undefined)
        findings.push({ code: 'DUPLICATE_HEADER', ref: c.ref, message: `header "${c.raw.trim()}" repeats ${first}` });
      else seen.set(key, c.ref);
    }
  }

  const records: TabularRecord[] = dataRows.map((r) => ({
    row: r.row,
    cells: Object.fromEntries(r.cells.map((c) => [c.column, c])),
  }));

  const columns: TabularColumn[] = columnList.map((col) => {
    const counts: Partial<Record<ValueClass, number>> = {};
    let ambiguousDate: string | undefined;
    let separated: string | undefined;
    let formulas = 0;
    let errors: string | undefined;
    for (const rec of records) {
      const c = rec.cells[col];
      if (c === undefined) continue;
      const k = classify(c, options.fromText);
      counts[k] = (counts[k] ?? 0) + 1;
      if (k === 'string' && SLASHED_DATE.test(c.raw.trim())) ambiguousDate ??= c.ref;
      if (k === 'string' && SEPARATED_NUMBER.test(c.raw.trim())) separated ??= c.ref;
      if (c.formula !== undefined) formulas++;
      if (k === 'error') errors ??= c.ref;
    }
    const header = headerByColumn.get(col);
    const name = header !== undefined ? header.raw.trim() : `Column ${columnLetter(col)}`;
    const declaredType = declare(counts);
    if (declaredType === 'mixed') {
      const parts = Object.entries(counts).map(([k, n]) => `${n} ${k}`);
      findings.push({
        code: 'MIXED_TYPES',
        ref: header?.ref ?? cellRef(grid.name, col, records[0]?.row ?? 1),
        message: `"${name}" holds ${parts.join(', ')}`,
      });
    }
    if (ambiguousDate !== undefined) {
      findings.push({
        code: 'AMBIGUOUS_DATE_FORMAT',
        ref: ambiguousDate,
        message: `"${name}" has dates written like 03/04/2026, which read differently day-first and month-first; they are kept as text`,
      });
    }
    if (separated !== undefined) {
      findings.push({
        code: 'NUMBER_WITH_SEPARATORS',
        ref: separated,
        message: `"${name}" has numbers written with separators (1,234.50); they are kept as text`,
      });
    }
    if (formulas > 0) {
      findings.push({
        code: 'FORMULA_RESULTS',
        ref: header?.ref ?? cellRef(grid.name, col, records[0]?.row ?? 1),
        message: `${formulas} value(s) in "${name}" are formula results cached by the workbook, not recomputed`,
      });
    }
    if (errors !== undefined) findings.push({ code: 'ERROR_VALUES', ref: errors, message: `"${name}" contains spreadsheet error values` });
    return {
      column: col,
      letter: columnLetter(col),
      header: name,
      ...(header !== undefined ? { headerRef: header.ref } : {}),
      declaredType,
      counts,
    };
  });

  const merged = new Set<string>();
  for (const r of [...(headerRow !== undefined ? [headerRow] : []), ...dataRows]) {
    for (const c of r.cells) {
      const m = inMerge(grid.merges, c.ref);
      if (m !== undefined) merged.add(m);
    }
  }
  if (merged.size > 0) {
    findings.push({
      code: 'MERGED_CELLS',
      ref: qualify(grid.name, [...merged][0]!),
      message: `merged range(s) ${[...merged].slice(0, 5).join(', ')}${merged.size > 5 ? ' and more' : ''}: only the first cell holds the value, and it was not copied into the others`,
    });
  }

  return {
    id,
    ...(grid.name !== undefined ? { sheet: grid.name } : {}),
    ...(headerRow !== undefined ? { headerRow: headerRow.row, headerEvidence: evidence } : {}),
    titles,
    columns,
    records,
    findings,
  };
}
