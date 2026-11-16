/**
 * RFC 4180 CSV reader (UW-3: "proper CSV"). Quoted fields, doubled quotes, separators and line breaks inside quotes, CRLF / LF / CR line
 * endings, a UTF-8 byte-order mark, and a delimiter worked out from the file (comma, semicolon, tab or pipe). Every cell keeps its exact
 * text and the record and line it came from.
 *
 * Refused loudly (never repaired): NUL bytes (binary data named .csv), a quote left open at the end of the file, and anything past the
 * limits. A quote inside an unquoted field is kept as text and reported (STRAY_QUOTE), because real exports contain `5" pipe`.
 */
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import { TABULAR_LIMITS, type TabularLimits } from './limits.js';
import { cellRef } from './refs.js';
import type { SheetGrid, TabularCell, TabularFinding } from './types.js';

export type CsvDelimiter = ',' | ';' | '\t' | '|';
const CANDIDATES: readonly CsvDelimiter[] = [',', ';', '\t', '|'];

export interface CsvReadOptions {
  /** Force a delimiter instead of detecting it. */
  readonly delimiter?: CsvDelimiter;
  readonly limits?: Partial<TabularLimits>;
}

export interface CsvGrid {
  readonly grid: SheetGrid;
  readonly delimiter: CsvDelimiter;
  readonly findings: readonly TabularFinding[];
}

const refuse = (message: string): Result<never, SourceError> =>
  err(new SourceError(ErrorCode.SERIALIZATION_SCHEMA_MISMATCH, `cannot read this CSV: ${message}`));

/**
 * The delimiter whose count per line (outside quotes) is the same on the most of the first lines, preferring more columns. A file with
 * one column and no candidate at all reads as comma-separated.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const lines: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < 20; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    if (!quoted && (ch === '\n' || ch === '\r')) {
      if (current.length > 0) lines.push(current);
      current = '';
      continue;
    }
    current += quoted && ch !== '"' ? '' : ch; // characters inside quotes never count
  }
  if (current.length > 0 && lines.length < 20) lines.push(current);
  let best: { d: CsvDelimiter; agree: number; width: number } | undefined;
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let width = 0;
    let agree = 0;
    for (const [c, f] of freq) if (f > agree || (f === agree && c > width)) [width, agree] = [c, f];
    if (agree === 0) continue;
    if (best === undefined || agree > best.agree || (agree === best.agree && width > best.width)) best = { d, agree, width };
  }
  return best?.d ?? ',';
}

export function readCsv(input: string, options: CsvReadOptions = {}): Result<CsvGrid, SourceError> {
  const limits: TabularLimits = { ...TABULAR_LIMITS, ...options.limits };
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.includes('\u0000')) return refuse('it contains NUL bytes, so it is binary data rather than text');
  if (text.trim().length === 0) return refuse('it is empty');
  const delimiter = options.delimiter ?? detectDelimiter(text);
  const findings: TabularFinding[] = [];

  const rows: { row: number; cells: TabularCell[] }[] = [];
  let record = 1;
  let line = 1;
  let recordLine = 1;
  let column = 1;
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let cells: TabularCell[] = [];
  let total = 0;
  let strayReported = false;

  const endField = (): Result<void, SourceError> => {
    if (field.length > limits.maxCellChars)
      return refuse(`the field at ${cellRef(undefined, column, record)} is longer than ${limits.maxCellChars} characters`);
    if (column > limits.maxColumns) return refuse(`record ${record} has more than ${limits.maxColumns} fields`);
    if (field.length > 0 || wasQuoted) {
      if (field.length > 0) {
        if (++total > limits.maxCells) return refuse(`it has more than ${limits.maxCells} values`);
        cells.push({ ref: cellRef(undefined, column, record), row: record, column, raw: field, kind: 'string', line: recordLine });
      }
    }
    field = '';
    wasQuoted = false;
    column++;
    return ok(undefined);
  };
  const endRecord = (): Result<void, SourceError> => {
    const ended = endField();
    if (!ended.ok) return ended;
    if (cells.length > 0) rows.push({ row: record, cells });
    if (record > limits.maxRows) return refuse(`it has more than ${limits.maxRows} records`);
    cells = [];
    column = 1;
    record++;
    return ok(undefined);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.length === 0 && !wasQuoted) {
        quoted = true;
        wasQuoted = true;
      } else {
        field += ch; // a quote inside an unquoted field: kept as text, reported once
        if (!strayReported) {
          findings.push({
            code: 'STRAY_QUOTE',
            ref: cellRef(undefined, column, record),
            message: 'a quote character appears inside an unquoted field; it was kept as text',
          });
          strayReported = true;
        }
      }
      continue;
    }
    if (ch === delimiter) {
      const ended = endField();
      if (!ended.ok) return ended;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      const ended = endRecord();
      if (!ended.ok) return ended;
      line++;
      recordLine = line;
      continue;
    }
    field += ch;
  }
  if (quoted) return refuse(`a quoted field that starts on line ${recordLine} is never closed`);
  if (field.length > 0 || wasQuoted || cells.length > 0) {
    const ended = endRecord();
    if (!ended.ok) return ended;
  }
  if (rows.length === 0) return refuse('it has no values');
  return ok({ grid: { index: 1, rows, merges: [] }, delimiter, findings });
}
