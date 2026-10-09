import type { Line } from './line-grouper.js';
import { detectListMarker } from './list-marker.js';

export type ClassifiedLineKind = 'heading' | 'paragraph' | 'list_item' | 'footnote';

export interface ClassifiedLine extends Line {
  readonly blockKind: ClassifiedLineKind;
  readonly headingLevel?: number; // present when blockKind === 'heading'
  readonly listMarker?: string; // present when blockKind === 'list_item'
  readonly listText?: string; // the line's text with the marker stripped, present when blockKind === 'list_item'
  readonly listKind?: 'ordered' | 'unordered'; // present when blockKind === 'list_item' — see list-marker.ts's DetectedListMarker doc comment
}

export interface PageForClassification {
  readonly pageNumber: number;
  readonly mediaBox: readonly [number, number, number, number];
  readonly lines: readonly Line[];
}

/** Bottom fraction of a page's height treated as the footnote zone — a real, if approximate, structural signal (most footnotes sit in a page's bottom margin), not a content-based rule. */
const FOOTNOTE_ZONE_FRACTION = 0.1;

/**
 * Classifies each line into a block kind using only structural signals —
 * font size relative to the document's adaptively-computed body size
 * (font-stats.ts), position on the page, and a leading list marker
 * (list-marker.ts). No semantic understanding of the line's content is
 * used or needed; that's Stage 4+'s job, via `@xo/ai-core`.
 */
export function classifyLines(pages: readonly PageForClassification[], bodySize: number, headingSizeLevels: readonly number[]): readonly ClassifiedLine[] {
  const classified: ClassifiedLine[] = [];

  for (const page of pages) {
    const pageHeight = page.mediaBox[3] - page.mediaBox[1];
    const footnoteThresholdY = page.mediaBox[1] + pageHeight * FOOTNOTE_ZONE_FRACTION;

    for (const line of page.lines) {
      if (line.text.trim().length === 0) continue;

      if (line.maxFontSizePt > bodySize) {
        const level = headingSizeLevels.indexOf(line.maxFontSizePt) + 1;
        classified.push({ ...line, blockKind: 'heading', headingLevel: level > 0 ? level : headingSizeLevels.length + 1 });
        continue;
      }

      if (line.maxFontSizePt < bodySize && line.y <= footnoteThresholdY) {
        classified.push({ ...line, blockKind: 'footnote' });
        continue;
      }

      const listMarker = detectListMarker(line.text);
      if (listMarker) {
        classified.push({ ...line, blockKind: 'list_item', listMarker: listMarker.marker, listText: listMarker.remainder, listKind: listMarker.listKind });
        continue;
      }

      classified.push({ ...line, blockKind: 'paragraph' });
    }
  }

  return classified;
}
