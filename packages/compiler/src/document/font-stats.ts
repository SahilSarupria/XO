import type { Line } from './line-grouper.js';

/**
 * Determines the document's "body" font size: the size accounting for the
 * most total characters across every line, not simply the most frequent
 * *line* size — a document with many short headings but one long body
 * paragraph per page should still identify the paragraph's size as
 * "body," which a per-line mode could get wrong. Adaptive per document
 * (never a hardcoded point size), since real-world contract PDFs vary
 * widely in their body font choice.
 */
export function computeBodyFontSize(lines: readonly Line[]): number {
  const charsBySize = new Map<number, number>();
  for (const line of lines) {
    if (line.text.trim().length === 0) continue;
    charsBySize.set(line.maxFontSizePt, (charsBySize.get(line.maxFontSizePt) ?? 0) + line.text.length);
  }
  if (charsBySize.size === 0) return 12; // no text at all — an arbitrary but harmless default; classification has nothing to classify either way

  let bestSize = 12;
  let bestChars = -1;
  for (const [size, chars] of charsBySize) {
    if (chars > bestChars) {
      bestChars = chars;
      bestSize = size;
    }
  }
  return bestSize;
}

/** Every distinct font size larger than `bodySize`, descending — used to assign heading levels (the largest present size is level 1, the next distinct size is level 2, and so on), adaptive to whatever heading sizes this specific document actually uses. */
export function computeHeadingSizeLevels(lines: readonly Line[], bodySize: number): readonly number[] {
  const sizes = new Set<number>();
  for (const line of lines) {
    if (line.text.trim().length > 0 && line.maxFontSizePt > bodySize) sizes.add(line.maxFontSizePt);
  }
  return [...sizes].sort((a, b) => b - a);
}
