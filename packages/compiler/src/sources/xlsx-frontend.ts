import { err, type Result } from '@xo/types';
import type { SourceError } from '@xo/errors';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { DocumentSourceFrontend } from './document-frontend.js';
import { computeSourceId } from './source-id.js';
import { extractXlsxText } from './xlsx-text.js';
import { ok } from '@xo/types';

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
    const extracted = extractXlsxText(input.bytes);
    if (!extracted.ok) return err(extracted.error);
    const doc = this.documents.ingest({ kind: 'document', text: extracted.value, sourcePath: input.sourcePath }, context);
    if (!doc.ok) return doc;
    return ok({
      ...doc.value,
      sourceId: computeSourceId('xlsx', input.sourcePath, extracted.value),
      sourceType: 'xlsx',
      metadata: { ...doc.value.metadata, format: 'xlsx' },
    });
  }
}
