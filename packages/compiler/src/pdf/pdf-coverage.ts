import { summarizeCoverage, type CoverageReport, type PageCoverageEntry } from '../document/page-coverage.js';
import type { LoadedPdfDocument, LoadedPdfPage } from './pdf-loader.js';

/**
 * WS1-01: decides, for every page of a loaded PDF, how it was accounted for (CRD-03).
 *
 * Precedence, most specific first:
 * 1. the page failed to load                      -> unaccounted / page_load_failed
 * 2. the page has text the parser read            -> extracted
 * 3. the page is provably blank (no content,
 *    no image)                                    -> excluded / blank_page
 * 4. the page looks scanned (image, no text)      -> unaccounted / requires_ocr_unavailable
 * 5. anything else with content but no text
 *    (vector art, outlined text, unreadable fonts) -> unaccounted / no_extractable_text
 *
 * Rule 5 is deliberate: a page that draws something but yields no text could be outlined text
 * that a human can read. It stays unaccounted rather than being guessed away.
 */
export function classifyPdfPage(page: LoadedPdfPage): PageCoverageEntry {
  if (page.loadFailure !== undefined) {
    return {
      page: page.pageNumber,
      status: 'unaccounted',
      reason: 'page_load_failed',
      detail: `${page.loadFailure.code}: ${page.loadFailure.message}`,
    };
  }
  if (page.recovery !== undefined) {
    return {
      page: page.pageNumber,
      status: 'ocr',
      detail: `text recovered by tier "${page.recovery.tier}" (confidence ${page.recovery.confidence.toFixed(2)})`,
    };
  }
  if (!page.requiresOcr) return { page: page.pageNumber, status: 'extracted' };
  if (page.isBlank) return { page: page.pageNumber, status: 'excluded', reason: 'blank_page' };
  if (page.hasImage) {
    return {
      page: page.pageNumber,
      status: 'unaccounted',
      reason: 'requires_ocr_unavailable',
      detail: 'page is image-based with no extractable text and no OCR engine is configured',
    };
  }
  return {
    page: page.pageNumber,
    status: 'unaccounted',
    reason: 'no_extractable_text',
    detail: 'page draws content but yields no readable text',
  };
}

export function computePdfCoverage(document: LoadedPdfDocument): CoverageReport {
  return summarizeCoverage(document.pages.map(classifyPdfPage));
}
