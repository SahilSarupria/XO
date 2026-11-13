import { err, type Result } from '@xo/types';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { DocumentSourceFrontend } from './document-frontend.js';
import { computeSourceId } from './source-id.js';
import { renderSheetsAsText } from './xlsx-text.js';
import { tabularFromXlsx } from '../tabular/index.js';
import { ok } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';

/** An Excel (.xlsx) workbook as raw bytes. Extracted deterministically; refused loudly if it cannot be read faithfully. */
export interface XlsxSourceInput {
  readonly kind: 'xlsx';
  readonly bytes: Uint8Array;
  readonly sourcePath: string;
}

function isXlsxSourceInput(input: unknown): input is XlsxSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const c = input as Partial<XlsxSourceInput>;
  return c.kind === 'xlsx' && c.bytes instanceof Uint8Array && typeof c.sourcePath === 'string';
}

/** Reuses the document frontend's block/section normalization so a XLSX flows through the identical downstream pipeline. */
export class XlsxSourceFrontend implements SourceFrontend<XlsxSourceInput> {
  readonly sourceType = 'xlsx' as const;
  private readonly documents = new DocumentSourceFrontend();

  canHandle(input: unknown): input is XlsxSourceInput {
    return isXlsxSourceInput(input);
  }

  ingest(input: XlsxSourceInput, context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    // One parse: the record sets and the text the semantic pipeline reads come from the same typed reader.
    const tables = tabularFromXlsx(input.bytes);
    if (!tables.ok) {
      return err(
        new SourceError(
          ErrorCode.PRECONDITION_FAILED,
          tables.error.message.replace(/^cannot read this workbook: /, 'could not read XLSX: '),
        ),
      );
    }
    const text = renderSheetsAsText(tables.value.sheets);
    if (text.length === 0) return err(new SourceError(ErrorCode.PRECONDITION_FAILED, 'the workbook contains no extractable text'));
    const doc = this.documents.ingest({ kind: 'document', text, sourcePath: input.sourcePath }, context);
    if (!doc.ok) return doc;
    if (doc.value.content.kind !== 'document') return doc;
    return ok({
      ...doc.value,
      sourceId: computeSourceId('xlsx', input.sourcePath, text),
      sourceType: 'xlsx',
      content: { ...doc.value.content, tables: tables.value },
      metadata: {
        ...doc.value.metadata,
        format: 'xlsx',
        sheetCount: String(tables.value.sheets.length),
        recordSetCount: String(tables.value.recordSets.length),
        recordCount: String(tables.value.recordSets.reduce((n, r) => n + r.records.length, 0)),
      },
    });
  }
}
