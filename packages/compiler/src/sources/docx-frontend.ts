import { err, type Result } from '@xo/types';
import type { SourceError } from '@xo/errors';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { DocumentSourceFrontend } from './document-frontend.js';
import { computeSourceId } from './source-id.js';
import { extractDocxText } from './docx-text.js';
import { ok } from '@xo/types';

/** A Word (.docx) document as raw bytes. Extracted deterministically; refused loudly if it cannot be read faithfully. */
export interface DocxSourceInput {
  readonly kind: 'docx';
  readonly bytes: Uint8Array;
  readonly sourcePath: string;
}

function isDocxSourceInput(input: unknown): input is DocxSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const c = input as Partial<DocxSourceInput>;
  return c.kind === 'docx' && c.bytes instanceof Uint8Array && typeof c.sourcePath === 'string';
}

/** Reuses the document frontend's block/section normalization so a DOCX flows through the identical downstream pipeline. */
export class DocxSourceFrontend implements SourceFrontend<DocxSourceInput> {
  readonly sourceType = 'docx' as const;
  private readonly documents = new DocumentSourceFrontend();

  canHandle(input: unknown): input is DocxSourceInput {
    return isDocxSourceInput(input);
  }

  ingest(input: DocxSourceInput, context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    const extracted = extractDocxText(input.bytes);
    if (!extracted.ok) return err(extracted.error);
    const doc = this.documents.ingest({ kind: 'document', text: extracted.value, sourcePath: input.sourcePath }, context);
    if (!doc.ok) return doc;
    return ok({
      ...doc.value,
      sourceId: computeSourceId('docx', input.sourcePath, extracted.value),
      sourceType: 'docx',
      metadata: { ...doc.value.metadata, format: 'docx' },
    });
  }
}
