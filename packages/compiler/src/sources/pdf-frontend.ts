import { err, ok, type Result } from '@xo/types';
import { ErrorCode, SourceError } from '@xo/errors';
import { NodePdfLoader, type PdfLoader } from '../pdf/pdf-loader.js';
import { parseDocument } from '../document/document-parser.js';
import type { SourceFrontend, SourceIngestContext } from './frontend.js';
import type { CanonicalSource } from './types.js';
import { computeSourceId } from './source-id.js';

export interface PdfSourceInput {
  readonly kind: 'pdf';
  readonly bytes: Uint8Array;
  readonly sourcePath: string;
}

const PDF_MAGIC = '%PDF-';

function looksLikePdfBytes(bytes: Uint8Array): boolean {
  if (bytes.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function isPdfSourceInput(input: unknown): input is PdfSourceInput {
  if (typeof input !== 'object' || input === null) return false;
  const candidate = input as Partial<PdfSourceInput>;
  if (candidate.kind === 'pdf') return candidate.bytes instanceof Uint8Array && typeof candidate.sourcePath === 'string';
  // Detection fallback (Stage 8 §5's "detection where appropriate"): an
  // untagged `{ bytes, sourcePath }` whose bytes start with the PDF
  // magic header is still recognizably a PDF, without requiring every
  // caller to remember to tag `kind: 'pdf'`.
  if (candidate.kind !== undefined) return false;
  return candidate.bytes instanceof Uint8Array && typeof candidate.sourcePath === 'string' && looksLikePdfBytes(candidate.bytes);
}

/**
 * Stage 8 §6 (mandatory): the existing PDF ingestion — `NodePdfLoader`
 * (`../pdf/pdf-loader.ts`) + `parseDocument` (`../document/document-parser.ts`)
 * — moved behind the `SourceFrontend` boundary with zero change to
 * either. Existing callers that construct `NodePdfLoader`/`parseDocument`
 * directly (every current test, the README's worked example) keep
 * working unmodified — this frontend is a pure wrapper, not a
 * replacement.
 */
export class PdfSourceFrontend implements SourceFrontend<PdfSourceInput> {
  readonly sourceType = 'pdf' as const;

  constructor(private readonly loader: PdfLoader = new NodePdfLoader()) {}

  canHandle(input: unknown): input is PdfSourceInput {
    return isPdfSourceInput(input);
  }

  ingest(input: PdfSourceInput, _context?: SourceIngestContext): Result<CanonicalSource, SourceError> {
    const loaded = this.loader.load(input.bytes, input.sourcePath);
    if (!loaded.ok) {
      return err(new SourceError(ErrorCode.SERIALIZATION_PARSE_FAILED, `Failed to load PDF source "${input.sourcePath}": ${loaded.error.message}`, { cause: loaded.error }));
    }

    const parsed = parseDocument(loaded.value);
    const plainText = loaded.value.pages.map((page) => page.plainText).join('\n\n');
    const sourceId = computeSourceId('pdf', input.sourcePath, input.bytes);

    const metadata: Record<string, string> = { pageCount: String(loaded.value.pageCount) };
    if (loaded.value.metadata.author !== undefined) metadata.author = loaded.value.metadata.author;
    if (loaded.value.metadata.creationDate !== undefined) metadata.creationDate = loaded.value.metadata.creationDate;

    return ok({
      sourceId,
      sourceType: 'pdf',
      sourcePath: input.sourcePath,
      content: { kind: 'document', parsed, documentTitle: loaded.value.metadata.title, plainText },
      metadata,
      semanticExtractionAvailable: true,
    });
  }
}
