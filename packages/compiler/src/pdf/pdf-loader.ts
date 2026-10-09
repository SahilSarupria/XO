import { err, ok, type Result } from '@xo/types';
import { PdfError } from '@xo/errors';
import type { TextRun } from './content-stream.js';
import { extractTextRuns } from './content-stream.js';
import { PdfDocument, type PdfMetadata, type RawPdfPage } from './document.js';
import { buildFontEncodingResolver, type FontEncoding } from './font-encoding.js';
import { textRunsToPlainText } from './text-runs-to-plain-text.js';

export interface LoadedPdfPage {
  readonly pageNumber: number; // 1-based, matches how a human would cite "page 3"
  /** The PDF indirect object number backing this page — carried through as provenance so a downstream XOIR node can point back at an exact byte range of the source file, not just "somewhere in this PDF." */
  readonly sourceObjectNumber: number;
  readonly mediaBox: readonly [number, number, number, number];
  readonly rotate: number;
  readonly plainText: string;
  readonly textRuns: readonly TextRun[];
  /** True if this page has no extractable text (or is dominated by a full-page image) — a scanned page that needs an OCR pass this compiler frontend does not itself perform. */
  readonly requiresOcr: boolean;
  /**
   * The same per-font `/ToUnicode` / base-encoding-plus-`/Differences`
   * resolver `plainText` above was decoded through (see `font-encoding.ts`).
   * Exposed here — not just consumed internally — because Stage 2
   * (`document/document-parser.ts` → `line-grouper.ts`) re-decodes
   * `textRuns` itself (it needs per-line, not per-page, text) rather than
   * reusing `plainText`; without this, Stage 1's font-encoding fix would
   * only reach `plainText` and Stage 2's heading/section structure would
   * still be built from raw-Latin-1-garbled line text.
   */
  readonly resolveFontEncoding: (fontName: string | undefined) => FontEncoding;
}

export interface LoadedPdfDocument {
  readonly sourcePath: string;
  readonly metadata: PdfMetadata;
  readonly pages: readonly LoadedPdfPage[];
  readonly pageCount: number;
}

/** Stage 1 of the compiler pipeline: PDF -> plain text (+ positioned text runs + provenance), per this package's README. */
export interface PdfLoader {
  load(bytes: Uint8Array, sourcePath: string): Result<LoadedPdfDocument, PdfError>;
}

function toLoadedPage(raw: RawPdfPage, doc: PdfDocument): LoadedPdfPage {
  const textRuns = extractTextRuns(raw.contentBytes);
  const resolveFontEncoding = buildFontEncodingResolver(raw.resources, (value) => doc.resolve(value));
  const plainText = textRunsToPlainText(textRuns, resolveFontEncoding);
  const hasText = plainText.trim().length > 0;
  return {
    pageNumber: raw.pageNumber,
    sourceObjectNumber: raw.objectNumber,
    mediaBox: raw.mediaBox,
    rotate: raw.rotate,
    plainText,
    textRuns,
    requiresOcr: !hasText || (raw.hasFullPageImageXObject && plainText.trim().length < 20),
    resolveFontEncoding,
  };
}

/**
 * The default, real `PdfLoader` implementation — pure Node (no external
 * dependency; see filters.ts/lexer.ts for why). Deterministic: the same
 * input bytes always produce the same `LoadedPdfDocument` (no wall-clock
 * reads, no random ids, page/run order strictly follows the PDF's own
 * page-tree and content-stream order).
 */
export class NodePdfLoader implements PdfLoader {
  load(bytes: Uint8Array, sourcePath: string): Result<LoadedPdfDocument, PdfError> {
    try {
      const doc = PdfDocument.load(bytes);
      const pages = doc.pages.map((raw) => toLoadedPage(raw, doc));
      return ok({ sourcePath, metadata: doc.info, pages, pageCount: pages.length });
    } catch (cause) {
      if (cause instanceof PdfError) return err(cause);
      throw cause;
    }
  }
}
