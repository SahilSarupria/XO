import { err, ok, type Result } from '@xo/types';
import type { SourceError } from '@xo/errors';
import type { DocumentBlock } from '../document/types.js';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';
import { readDocx } from './docx-text.js';
import { parsedDocumentFromBlocks, syntheticProvenance } from './block-source-helpers.js';

/** A Word (.docx) document as raw bytes. Read deterministically; refused loudly if it cannot be read faithfully. */
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

/**
 * UW-3c: the document's own structure — headings, numbered and bulleted lists with their positions and nesting, check boxes,
 * tables — becomes blocks directly (`structured-blocks/docx-blocks.ts`), instead of going through a text rendering that lost
 * list numbering and fused table cells.
 */
export class DocxSourceFrontend implements SourceFrontend<DocxSourceInput> {
  readonly sourceType = 'docx' as const;

  canHandle(input: unknown): input is DocxSourceInput {
    return isDocxSourceInput(input);
  }

  ingest(input: DocxSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    const read = readDocx(input.bytes);
    if (!read.ok) return err(read.error);
    const raw = read.value.blocks;
    const blocks: DocumentBlock[] = raw.map((b, i) => ({ ...b, provenance: syntheticProvenance(1, i, raw.length) }) as DocumentBlock);
    const plainText = raw.map((b) => (b.kind === 'table_row' ? b.cells.join(' | ') : b.text)).join('\n\n');
    const firstHeading = raw.find((b) => b.kind === 'heading');
    return ok({
      sourceId: computeSourceId('docx', input.sourcePath, plainText),
      sourceType: 'docx',
      sourcePath: input.sourcePath,
      content: {
        kind: 'document',
        parsed: parsedDocumentFromBlocks(blocks),
        documentTitle: firstHeading !== undefined && firstHeading.kind === 'heading' ? firstHeading.text : undefined,
        plainText,
      },
      metadata: {
        format: 'docx',
        blockCount: String(raw.length),
        ...(read.value.notes.length > 0 ? { readingNotes: read.value.notes.join(' ') } : {}),
      },
      semanticExtractionAvailable: true,
    });
  }
}
