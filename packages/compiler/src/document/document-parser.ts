import type { LoadedPdfDocument } from '../pdf/pdf-loader.js';
import { groupRunsIntoLines } from './line-grouper.js';
import { computeBodyFontSize, computeHeadingSizeLevels } from './font-stats.js';
import { classifyLines, type PageForClassification } from './block-classifier.js';
import { buildBlocks } from './block-builder.js';
import { buildSections } from './section-builder.js';
import type { ParsedDocument } from './types.js';

/**
 * Stage 2: turns Stage 1's per-page positioned text runs into a
 * structural document tree (headings/paragraphs/lists/footnotes,
 * nested into sections by heading level). Pages flagged
 * `requiresOcr` (see pdf-loader.ts) contribute no lines — there is
 * nothing structural to parse from a page with no extracted text.
 * Entirely deterministic: same `LoadedPdfDocument` in, same
 * `ParsedDocument` out, every time.
 */
export function parseDocument(document: LoadedPdfDocument): ParsedDocument {
  const pages: PageForClassification[] = document.pages
    .filter((page) => !page.requiresOcr)
    .map((page) => ({
      pageNumber: page.pageNumber,
      mediaBox: page.mediaBox,
      lines: groupRunsIntoLines(page.pageNumber, page.textRuns, page.resolveFontEncoding),
    }));

  const allLines = pages.flatMap((p) => p.lines);
  const bodySize = computeBodyFontSize(allLines);
  const headingSizeLevels = computeHeadingSizeLevels(allLines, bodySize);

  const classified = classifyLines(pages, bodySize, headingSizeLevels);
  const blocks = buildBlocks(classified, bodySize);
  const root = buildSections(blocks);

  return { root, bodyFontSizePt: bodySize };
}
