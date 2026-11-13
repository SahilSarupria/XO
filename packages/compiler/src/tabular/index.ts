import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import type { SourceError } from '@xo/errors';
import { readCsv, type CsvReadOptions } from './csv.js';
import { readXlsxWorkbook } from './xlsx.js';
import { recordSetsFromGrid } from './records.js';
import type { TabularLimits } from './limits.js';
import type { TabularCell, TabularSource } from './types.js';

export * from './types.js';
export { TABULAR_LIMITS, type TabularLimits } from './limits.js';
export { readCsv, detectDelimiter, type CsvDelimiter, type CsvReadOptions } from './csv.js';
export { readXlsxWorkbook, isDateFormatCode, serialToIso, type XlsxWorkbook } from './xlsx.js';
export { recordSetsFromGrid, classify as classifyTabularValue } from './records.js';
export { columnLetter, cellRef, parseA1 } from './refs.js';

/** A workbook as record sets (one or more per sheet). */
export function tabularFromXlsx(
  bytes: Uint8Array,
  options: { readonly limits?: Partial<TabularLimits> } = {},
): Result<TabularSource, SourceError> {
  const wb = readXlsxWorkbook(bytes, options);
  if (!wb.ok) return err(wb.error);
  const recordSets = wb.value.sheets.flatMap((s) => recordSetsFromGrid(s, { fromText: false }));
  return ok({ format: 'xlsx', sheets: wb.value.sheets, recordSets, findings: wb.value.findings });
}

/** A CSV file as record sets. */
export function tabularFromCsv(text: string, options: CsvReadOptions = {}): Result<TabularSource, SourceError> {
  const read = readCsv(text, options);
  if (!read.ok) return err(read.error);
  return ok({
    format: 'csv',
    sheets: [read.value.grid],
    recordSets: recordSetsFromGrid(read.value.grid, { fromText: true }),
    findings: read.value.findings,
  });
}

/**
 * The value a cell holds, converted the one way its storage allows: numbers to numbers, booleans to booleans, everything else (dates
 * included: use `cell.date.iso`) as the stored text. Conversion is the consumer's explicit choice; record sets themselves never convert.
 */
export function cellValue(cell: TabularCell): string | number | boolean {
  if (cell.kind === 'number') return Number(cell.raw);
  if (cell.kind === 'boolean') return cell.raw === '1';
  return cell.raw;
}
