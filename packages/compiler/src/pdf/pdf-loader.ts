import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PdfError } from '@xo/errors';
import type { TextRun } from './content-stream.js';
import { extractTextRuns } from './content-stream.js';
import { PdfDocument, type PdfLoadOptions, type PdfMetadata, type RawPdfPage } from './document.js';
import { ABORTED_CODE, PdfAbortedError, PdfResourceLimitError, RESOURCE_LIMIT_CODE, throwIfCancelled } from './limits.js';
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
  /** True when the page holds no content at all: empty content streams and no image. Only such a page may be excluded from coverage as blank. */
  readonly isBlank: boolean;
  /** True when the page's resources hold any image XObject (a scan or figure). Distinguishes "needs OCR" from "draws something that is not text". */
  readonly hasImage: boolean;
  /** Set when this page had no readable text layer and its text was recovered by a later tier (OCR, a second reader, a vision model). Coverage reports such a page as `ocr`, never as ordinary extracted text. */
  readonly recovery?: { readonly tier: string; readonly confidence: number };
  /** Set when this page could not be loaded; the failure is isolated to the page (WS1-02) and the coverage ledger records it as unaccounted. */
  readonly loadFailure?: { readonly code: string; readonly message: string };
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
  load(bytes: Uint8Array, sourcePath: string, options?: PdfLoadOptions): Result<LoadedPdfDocument, PdfError>;
}

const NO_FONT_ENCODING: FontEncoding = { codeByteWidth: 1, decode: (bytes) => Buffer.from(bytes).toString('latin1') };

/**
 * A text layer that decodes to placeholders (a composite font with no /ToUnicode yields one U+FFFD per code) carries no
 * information. Treating it as text would hand downstream stages garbage rated `trusted`; treating it as "no text layer"
 * routes the page to recovery (a second reader, OCR) or leaves it visibly unaccounted.
 */
export function isUnreadableTextLayer(text: string): boolean {
  let visible = 0;
  let placeholders = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    visible += 1;
    if (ch === '\uFFFD') placeholders += 1;
  }
  return visible > 0 && placeholders / visible >= 0.5;
}

function toLoadedPage(raw: RawPdfPage, doc: PdfDocument, options: PdfLoadOptions): LoadedPdfPage {
  const base = {
    pageNumber: raw.pageNumber,
    sourceObjectNumber: raw.objectNumber,
    mediaBox: raw.mediaBox,
    rotate: raw.rotate,
  };
  if (raw.loadFailure !== undefined) return failedLoadedPage(base, raw.loadFailure);
  try {
    throwIfCancelled(options);
    const textRuns = extractTextRuns(raw.contentBytes);
    const resolveFontEncoding = buildFontEncodingResolver(raw.resources, (value) => doc.resolve(value));
    const plainText = textRunsToPlainText(textRuns, resolveFontEncoding);
    const hasText = plainText.trim().length > 0 && !isUnreadableTextLayer(plainText);
    return {
      ...base,
      plainText,
      textRuns,
      requiresOcr: !hasText || (raw.hasFullPageImageXObject && plainText.trim().length < 20),
      isBlank: !hasText && raw.isContentEmpty && !raw.hasImageXObject,
      hasImage: raw.hasImageXObject,
      resolveFontEncoding,
    };
  } catch (cause) {
    // WS1-02: one malformed page must not reject the customer's whole document.
    return failedLoadedPage(base, {
      code:
        cause instanceof PdfResourceLimitError
          ? RESOURCE_LIMIT_CODE
          : cause instanceof PdfAbortedError
            ? ABORTED_CODE
            : cause instanceof PdfError
              ? String(cause.code)
              : 'PDF_PAGE_LOAD_FAILED',
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function failedLoadedPage(
  base: Pick<LoadedPdfPage, 'pageNumber' | 'sourceObjectNumber' | 'mediaBox' | 'rotate'>,
  failure: { readonly code: string; readonly message: string },
): LoadedPdfPage {
  return {
    ...base,
    plainText: '',
    textRuns: [],
    requiresOcr: false,
    isBlank: false,
    hasImage: false,
    loadFailure: failure,
    resolveFontEncoding: () => NO_FONT_ENCODING,
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
  /**
   * Never throws: hostile or corrupt input yields `err(PdfError)` for the document, or a per-page `loadFailure`
   * (reported as unaccounted), and a stack overflow or any other unexpected exception is converted to the same.
   */
  load(bytes: Uint8Array, sourcePath: string, options: PdfLoadOptions = {}): Result<LoadedPdfDocument, PdfError> {
    try {
      const doc = PdfDocument.load(bytes, options);
      const pages = doc.pages.map((raw) => toLoadedPage(raw, doc, options));
      return ok({ sourcePath, metadata: doc.info, pages, pageCount: pages.length });
    } catch (cause) {
      if (cause instanceof PdfError) return err(cause);
      return err(
        new PdfError(
          ErrorCode.PDF_MALFORMED,
          `Unexpected failure while reading PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
          {
            cause,
          },
        ),
      );
    }
  }
}
