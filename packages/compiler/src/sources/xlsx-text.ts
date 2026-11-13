/**
 * XLSX as text for the shared document pipeline: every non-empty row as one pipe-separated line under a `## <sheet name>` heading, so
 * rules written in cells reach the same extraction as rules written in prose. Since UW-3 this is rendered from the typed reader
 * (`../tabular/xlsx.ts`), so the text and the record sets come from one parse with one set of refusals: values appear as stored (date
 * serials stay serials here; their reading is in the record sets), booleans as TRUE/FALSE, and empty cells keep column positions.
 */
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import { readXlsxWorkbook } from '../tabular/xlsx.js';
import type { SheetGrid } from '../tabular/types.js';

export function renderSheetsAsText(sheets: readonly SheetGrid[]): string {
  const sections: string[] = [];
  for (const sheet of sheets) {
    const lines: string[] = [];
    for (const r of sheet.rows) {
      const cells: string[] = [];
      for (const c of r.cells) {
        while (cells.length < c.column - 1) cells.push('');
        const value = c.kind === 'boolean' ? (c.raw === '1' ? 'TRUE' : 'FALSE') : c.raw;
        cells[c.column - 1] = value.replace(/\s+/g, ' ').trim();
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.some((x) => x.length > 0)) lines.push(cells.join(' | '));
    }
    if (lines.length > 0) sections.push(`## ${sheet.name ?? 'Sheet'}\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

export function extractXlsxText(bytes: Uint8Array): Result<string, SourceError> {
  const wb = readXlsxWorkbook(bytes);
  if (!wb.ok)
    return err(
      new SourceError(ErrorCode.PRECONDITION_FAILED, wb.error.message.replace(/^cannot read this workbook: /, 'could not read XLSX: ')),
    );
  const text = renderSheetsAsText(wb.value.sheets);
  if (text.length === 0) return err(new SourceError(ErrorCode.PRECONDITION_FAILED, 'the workbook contains no extractable text'));
  return ok(text);
}
