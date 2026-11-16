import { estimateRunAdvanceWidth, type Line } from './line-grouper.js';
import { detectListMarker, detectStandaloneMarker, markerOrdinal, splitTitleBody } from './list-marker.js';
import { decodeRunText } from '../pdf/text-runs-to-plain-text.js';

export type ClassifiedLineKind = 'heading' | 'paragraph' | 'list_item' | 'footnote';

export interface ClassifiedLine extends Line {
  readonly blockKind: ClassifiedLineKind;
  readonly headingLevel?: number; // present when blockKind === 'heading'
  readonly listMarker?: string; // present when blockKind === 'list_item'
  readonly listText?: string; // the line's text with the marker stripped, present when blockKind === 'list_item'
  readonly listKind?: 'ordered' | 'unordered'; // present when blockKind === 'list_item' — see list-marker.ts's DetectedListMarker doc comment
  /** UW-3b: present when the list marker is a checkbox. */
  readonly checkbox?: 'unchecked' | 'checked';
  /** UW-3b: the position the marker claims (`3.` → 3), when it claims one. */
  readonly ordinal?: number;
  /** UW-3b: a short title the author set apart from the item's body (a bold run, or a short first sentence). */
  readonly itemTitle?: string;
  readonly itemBody?: string;
  /** UW-3b: this paragraph line is the wrapped continuation of the list item on the line above it (same text column, tight gap). */
  readonly listContinuation?: true;
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
export function classifyLines(
  pages: readonly PageForClassification[],
  bodySize: number,
  headingSizeLevels: readonly number[],
): readonly ClassifiedLine[] {
  const classified: ClassifiedLine[] = [];

  for (const page of pages) {
    const pageHeight = page.mediaBox[3] - page.mediaBox[1];
    const footnoteThresholdY = page.mediaBox[1] + pageHeight * FOOTNOTE_ZONE_FRACTION;
    const structural = detectStructuralListLines(page.lines, bodySize);

    for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
      const line = page.lines[lineIndex]!;
      if (line.text.trim().length === 0) continue;

      // UW-3b: a bullet or checkbox marks a list item whatever its type size. Headings are numbered ("2. Scope"), but a
      // generator that sets its bullets half a point above body text must not turn every bullet into a heading.
      const leadingMarker = detectListMarker(line.text);
      const bulletLed = leadingMarker !== undefined && leadingMarker.listKind === 'unordered' && leadingMarker.remainder.length > 0;

      if (line.maxFontSizePt > bodySize && !bulletLed) {
        const level = headingSizeLevels.indexOf(line.maxFontSizePt) + 1;
        classified.push({ ...line, blockKind: 'heading', headingLevel: level > 0 ? level : headingSizeLevels.length + 1 });
        continue;
      }

      if (line.maxFontSizePt < bodySize && line.y <= footnoteThresholdY) {
        classified.push({ ...line, blockKind: 'footnote' });
        continue;
      }

      const item = structural.items.get(lineIndex);
      if (item !== undefined) {
        classified.push({ ...line, blockKind: 'list_item', ...item });
        continue;
      }
      if (structural.continuations.has(lineIndex)) {
        classified.push({ ...line, blockKind: 'paragraph', listContinuation: true });
        continue;
      }

      const listMarker = leadingMarker;
      if (listMarker) {
        const titled = listMarker.checkbox === undefined ? splitTitleBody(listMarker.remainder) : undefined;
        classified.push({
          ...line,
          blockKind: 'list_item',
          listMarker: listMarker.marker,
          listText: listMarker.remainder,
          listKind: listMarker.listKind,
          ...(listMarker.checkbox !== undefined ? { checkbox: listMarker.checkbox } : {}),
          ...(listMarker.listKind === 'ordered' && markerOrdinal(listMarker.marker) !== undefined
            ? { ordinal: markerOrdinal(listMarker.marker)! }
            : {}),
          ...(titled !== undefined ? { itemTitle: titled.title, itemBody: titled.body } : {}),
        });
        continue;
      }

      classified.push({ ...line, blockKind: 'paragraph' });
    }
  }

  return classified;
}

// ── UW-3b: structural list markers ──────────────────────────────────────────────────────────────────────────────────
//
// Many generators print a list's marker in a column of its own: "1" at one x, the item text at another, and a wrapped
// line of the item at the text's x with no marker. Text alone cannot tell "1 One task, one purpose." from "123 Main
// Street", but the layout can. A line is read as a marker-led item only when ALL of these hold:
//   - its first run is nothing but a marker token (digits, a letter, a roman numeral, a bullet or a checkbox);
//   - every other run of the line starts at one text column (so it is not a table row with several cells);
//   - it belongs to a run of at least two such lines on the page with the same marker column and text column, and
//     numbered markers count up by one (bullets and checkboxes repeat).
// Lines between two items that start at the text column, within a wrapped-line gap of the line above, are the
// previous item's continuation. Anything else ends the list. A single isolated "4  some text" stays prose.

const STRUCTURAL_X_TOLERANCE = 3;
/** Same rule block-builder.ts uses to tell a wrapped line from a new paragraph. */
const WRAP_GAP_MULTIPLIER = 1.6;
const MIN_STRUCTURAL_ITEMS = 2;
const MAX_TITLE_WORDS = 8;
/** Horizontal gap, in points, up to which the next run on a line continues the same text (word spacing, a font change). */
const FLOW_GAP_PT = 8;
const MIN_MARKER_GAP_PT = 4;
const MARKER_GAP_FONT_MULTIPLIER = 0.8;

interface StructuralItem {
  readonly listMarker: string;
  readonly listText: string;
  readonly listKind: 'ordered' | 'unordered';
  readonly checkbox?: 'unchecked' | 'checked';
  readonly ordinal?: number;
  readonly itemTitle?: string;
  readonly itemBody?: string;
}

interface Candidate {
  readonly index: number;
  readonly markerX: number;
  readonly textX: number;
  readonly marker: NonNullable<ReturnType<typeof detectStandaloneMarker>>;
  readonly item: StructuralItem;
}

interface DecodedRun {
  readonly x: number;
  readonly fontName: string | undefined;
  readonly fontSizePt: number;
  readonly text: string;
}

/** A line's non-blank runs with their decoded text (the page's font encodings when the line grouper recorded them). */
export function decodedRuns(line: Line): readonly DecodedRun[] {
  return line.runs
    .map((r, k) => ({ x: r.x, fontName: r.fontName, fontSizePt: r.fontSizePt, text: line.runTexts?.[k] ?? decodeRunText(r) }))
    .filter((r) => r.text.trim().length > 0);
}

function candidateOf(line: Line, index: number): Candidate | undefined {
  const runs = decodedRuns(line);
  if (runs.length < 2) return undefined;
  const markerText = runs[0]!.text;
  const marker = detectStandaloneMarker(markerText);
  if (marker === undefined) return undefined;
  const rest = runs.slice(1);
  const textX = rest[0]!.x;
  // The marker stands in a column of its own: real white space between it and the text, not a glyph-width step.
  const markerEnd = runs[0]!.x + estimateRunAdvanceWidth(markerText.trim(), runs[0]!.fontSizePt);
  if (textX - markerEnd < Math.max(MIN_MARKER_GAP_PT, MARKER_GAP_FONT_MULTIPLIER * runs[0]!.fontSizePt)) return undefined;
  // Every other run starts in the text column or continues the text flow of the run before it (a font change mid-line):
  // a run that starts a column of its own means a table row, which block-builder.ts reads instead.
  for (let k = 1; k < rest.length; k += 1) {
    const r = rest[k]!;
    const prev = rest[k - 1]!;
    const inTextColumn = Math.abs(r.x - textX) <= STRUCTURAL_X_TOLERANCE;
    const continuesFlow = r.x >= prev.x && r.x - (prev.x + estimateRunAdvanceWidth(prev.text, prev.fontSizePt)) <= FLOW_GAP_PT;
    if (!inTextColumn && !continuesFlow) return undefined;
  }
  const lead = line.text.trimStart();
  const markerToken = markerText.trim();
  if (!lead.startsWith(markerToken)) return undefined;
  const listText = lead.slice(markerToken.length).replace(/\s+/g, ' ').trim();
  if (listText.length === 0) return undefined;
  // A title the author set in a different font from its body (typically bold), when it is short.
  let titled: { title: string; body: string } | undefined;
  if (rest.length >= 2 && rest[0]!.fontName !== undefined && rest[0]!.fontName !== rest[1]!.fontName) {
    const head = rest[0]!.text.trim();
    const title = head.replace(/[.:]$/, '');
    const body = listText.startsWith(head) ? listText.slice(head.length).trim() : '';
    if (title.length > 0 && body.length > 0 && title.split(/\s+/).length <= MAX_TITLE_WORDS) titled = { title, body };
  }
  titled ??= marker.checkbox === undefined ? splitTitleBody(listText) : undefined;
  return {
    index,
    markerX: runs[0]!.x,
    textX,
    marker,
    item: {
      listMarker: marker.marker,
      listText,
      listKind: marker.listKind,
      ...(marker.checkbox !== undefined ? { checkbox: marker.checkbox } : {}),
      ...(marker.ordinal !== undefined ? { ordinal: marker.ordinal } : {}),
      ...(titled !== undefined ? { itemTitle: titled.title, itemBody: titled.body } : {}),
    },
  };
}

function sameKind(a: Candidate, b: Candidate): boolean {
  if (Math.abs(a.markerX - b.markerX) > STRUCTURAL_X_TOLERANCE || Math.abs(a.textX - b.textX) > STRUCTURAL_X_TOLERANCE) return false;
  if (a.marker.ordinal !== undefined || b.marker.ordinal !== undefined) {
    const punct = (m: string): string => m.replace(/^[^.)]*/, '');
    return a.marker.ordinal !== undefined && b.marker.ordinal === a.marker.ordinal + 1 && punct(a.marker.marker) === punct(b.marker.marker);
  }
  return a.marker.checkbox !== undefined ? b.marker.checkbox !== undefined : a.marker.marker === b.marker.marker;
}

export function detectStructuralListLines(
  lines: readonly Line[],
  bodySize: number,
): { readonly items: ReadonlyMap<number, StructuralItem>; readonly continuations: ReadonlySet<number> } {
  const items = new Map<number, StructuralItem>();
  const continuations = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    const first = candidateOf(lines[i]!, i);
    if (first === undefined) {
      i += 1;
      continue;
    }
    const group: Candidate[] = [first];
    const groupContinuations: number[] = [];
    let previous = first;
    let lastLine = lines[i]!;
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j]!;
      if (line.text.trim().length === 0) {
        j += 1;
        continue;
      }
      const next = candidateOf(line, j);
      if (next !== undefined && sameKind(previous, next)) {
        group.push(next);
        previous = next;
        lastLine = line;
        j += 1;
        continue;
      }
      const runs = decodedRuns(line);
      const tight = lastLine.y - line.y > 0 && lastLine.y - line.y <= bodySize * WRAP_GAP_MULTIPLIER;
      if (next === undefined && runs.length > 0 && Math.abs(runs[0]!.x - previous.textX) <= STRUCTURAL_X_TOLERANCE && tight) {
        groupContinuations.push(j);
        lastLine = line;
        j += 1;
        continue;
      }
      break;
    }
    if (group.length >= MIN_STRUCTURAL_ITEMS) {
      for (const c of group) items.set(c.index, c.item);
      for (const k of groupContinuations) continuations.add(k);
      i = j;
    } else {
      i += 1;
    }
  }
  return { items, continuations };
}
