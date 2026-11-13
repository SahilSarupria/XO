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
  /**
   * UW-3c: the page's text was recovered (OCR) rather than read from its text layer. Recovered lines carry no font names and
   * only estimated sizes, so bold and size cannot mark headings; layout does (`recoveredHeading`).
   */
  readonly recovered?: true;
}

/** A recovered heading is short: at most this many words, with no sentence punctuation at its end. */
const RECOVERED_HEADING_MAX_WORDS = 6;
/** ... and set apart: the blank space above it clearly exceeds the page's usual space between lines. */
const RECOVERED_HEADING_SPACE_EM = 0.45;
/** OCR sizes are estimated as 0.8 of a line box's height; this recovers the box height. */
const OCR_BOX_HEIGHT_FACTOR = 1 / 0.8;

/** Blank space between the bottom of line `k - 1` and the top of line `k` (OCR positions are box bottoms). */
function spaceAbove(lines: readonly Line[], k: number): number {
  const prev = lines[k - 1];
  if (prev === undefined) return Number.POSITIVE_INFINITY;
  const line = lines[k]!;
  return prev.y - (line.y + line.maxFontSizePt * OCR_BOX_HEIGHT_FACTOR);
}

/** The page's typical blank space between consecutive lines (the median over lines that are close together). */
function typicalLineSpace(lines: readonly Line[], bodySize: number): number {
  const spaces: number[] = [];
  for (let k = 1; k < lines.length; k++) {
    const sp = spaceAbove(lines, k);
    if (sp > -bodySize && sp < bodySize * 2) spaces.push(sp);
  }
  spaces.sort((a, b) => a - b);
  return spaces.length > 0 ? spaces[Math.floor(spaces.length / 2)]! : 0;
}

function recoveredHeading(lines: readonly Line[], index: number, typicalSpace: number, bodySize: number): boolean {
  const line = lines[index]!;
  const text = line.text.trim();
  if (text.split(/\s+/).length > RECOVERED_HEADING_MAX_WORDS || /[.;,:!]["')\]]?$/.test(text) || detectListMarker(text) !== undefined)
    return false;
  if (!/^[\p{Lu}\d]/u.test(text)) return false;
  const above = spaceAbove(lines, index);
  const below = index + 1 < lines.length ? spaceAbove(lines, index + 1) : Number.POSITIVE_INFINITY;
  return above >= typicalSpace + bodySize * RECOVERED_HEADING_SPACE_EM && below >= typicalSpace - bodySize * 0.2;
}

/** On a recovered page, "1 Early in the project ..." whose next numbered line is "2. ..." lost its period to OCR. */
function recoveredBareNumber(lines: readonly Line[], index: number): string | undefined {
  const m = /^(\d{1,2})\s+(?=\p{Lu})/u.exec(lines[index]!.text.trim());
  if (m === null) return undefined;
  for (let k = index + 1; k < Math.min(lines.length, index + 4); k++) {
    const next = detectListMarker(lines[k]!.text);
    if (next !== undefined && next.listKind === 'ordered') return markerOrdinal(next.marker) === Number(m[1]) + 1 ? `${m[1]}.` : undefined;
  }
  return undefined;
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
    // UW-3c: the last text-marked list item on this page, so its wrapped lines can join it.
    const lineSpace = page.recovered === true ? typicalLineSpace(page.lines, bodySize) : 0;
    let openItem:
      | {
          readonly markerX: number;
          readonly textX: number;
          readonly y: number;
          readonly size: number;
          readonly open: boolean;
          readonly bold: boolean;
        }
      | undefined;

    for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
      const original = page.lines[lineIndex]!;
      if (original.text.trim().length === 0) continue;
      const bare = page.recovered === true ? recoveredBareNumber(page.lines, lineIndex) : undefined;
      const line = bare !== undefined ? { ...original, text: original.text.trim().replace(/^\d{1,2}\s+/, `${bare} `) } : original;

      // UW-3b: a bullet or checkbox marks a list item whatever its type size. Headings are numbered ("2. Scope"), but a
      // generator that sets its bullets half a point above body text must not turn every bullet into a heading.
      const leadingMarker = detectListMarker(line.text);
      const bulletLed = leadingMarker !== undefined && leadingMarker.listKind === 'unordered' && leadingMarker.remainder.length > 0;

      // UW-3c: the wrapped tail of a list item whose marker is part of its text ("2. Plan to send ... probably Friday or" /
      // "Monday."), within a wrapped-line gap: a line at the item's text column, or — when the item's line stops mid-sentence
      // or the line goes on in lower case — a line back at the marker's column (a layout without a hanging indent).
      if (openItem !== undefined && leadingMarker === undefined && !structural.items.has(lineIndex)) {
        const gap = openItem.y - line.y;
        const x = line.minX;
        const reach = x <= openItem.textX + openItem.size * CONTINUATION_X_REACH;
        // A wrapped line indented with spaces ("    in case of ...") sits at the text column visually, whatever its x.
        const atText = x >= openItem.textX - CONTINUATION_X_SLACK_PT || /^ {2,}\S/.test(line.text);
        const atMarker = x >= openItem.markerX - CONTINUATION_X_SLACK_PT && (openItem.open || /^\p{Ll}/u.test(line.text.trim()));
        // (`open` is set only when the item's line visibly stops mid-sentence: a comma, or a function word last.)
        const sameSize = Math.abs(line.maxFontSizePt - openItem.size) <= 0.6 || line.maxFontSizePt <= openItem.size;
        // A bold line after a regular item (or the reverse) is a label or heading of its own, not the item's next line.
        const sameWeight = boldLine(line) === openItem.bold;
        // A line that carries on an unfinished sentence may sit a little further down (OCR line boxes, looser leading).
        const maxGap = openItem.size * (openItem.open ? OPEN_SENTENCE_GAP_MULTIPLIER : WRAP_GAP_MULTIPLIER);
        if (reach && (atText || atMarker) && sameSize && sameWeight && gap > 0 && gap <= maxGap) {
          classified.push({ ...line, blockKind: 'paragraph', listContinuation: true });
          openItem = { ...openItem, y: line.y, open: unfinished(line.text) };
          continue;
        }
      }
      openItem = undefined;

      if (line.maxFontSizePt > bodySize && !bulletLed && headingShaped(line.text, leadingMarker)) {
        const level = headingSizeLevels.indexOf(line.maxFontSizePt) + 1;
        classified.push({ ...line, blockKind: 'heading', headingLevel: level > 0 ? level : headingSizeLevels.length + 1 });
        continue;
      }
      if (page.recovered === true && recoveredHeading(page.lines, lineIndex, lineSpace, bodySize)) {
        classified.push({ ...line, blockKind: 'heading', headingLevel: headingSizeLevels.length + 1 });
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
        // Where the item's text starts: past the marker, by the marker's own width at this size.
        openItem = {
          markerX: line.minX,
          textX: line.minX + (listMarker.marker.length + 1) * line.maxFontSizePt * 0.45,
          y: line.y,
          size: Math.max(line.maxFontSizePt, bodySize),
          open: unfinished(line.text),
          bold: boldLine(line),
        };
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
/** How far left of the estimated text start a wrapped line may begin (marker widths are estimated, not measured). */
const CONTINUATION_X_SLACK_PT = 3;
/** ... and how far right, in multiples of the type size: a wrapped line sits at the item's text, not further across the page. */
const CONTINUATION_X_REACH = 1.5;
const OPEN_SENTENCE_GAP_MULTIPLIER = 2;
const MAX_NUMBERED_HEADING_WORDS = 8;

const SENTENCE_END = /(?:[.!?:;]["')\]]?|[)\]])\s*$/;

const FUNCTION_WORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'as',
  'per',
  'by',
  'for',
  'with',
  'and',
  'or',
  'nor',
  'but',
  'in',
  'on',
  'at',
  'from',
  'into',
  'that',
  'which',
  'who',
  'whose',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'not',
  'if',
  'than',
  'under',
  'within',
  'without',
  'any',
  'all',
  'each',
  'every',
  'its',
  'their',
  'your',
  'our',
  'this',
  'these',
  'those',
  'such',
  'shall',
  'must',
  'may',
  'will',
  'should',
  'can',
]);

/** A line that visibly stops mid-sentence: it ends with a comma, a dash, or a function word ("... as per", "... the policy is not"). */
function unfinished(text: string): boolean {
  const t = text.trim();
  if (SENTENCE_END.test(t)) return false;
  if (/[,\-–—]$/.test(t)) return true;
  const last = /([\p{L}]+)$/u.exec(t)?.[1]?.toLowerCase();
  return last !== undefined && FUNCTION_WORDS.has(last);
}

/** Most of the line's text is set in a bold face (by font name; OCR'd lines have none and read as regular). */
function boldLine(line: Line): boolean {
  let bold = 0;
  let all = 0;
  line.runs.forEach((r, i) => {
    const n = (line.runTexts?.[i] ?? '').trim().length || 1;
    all += n;
    if (r.fontName !== undefined && /bold|black|heavy|semibold|demi/i.test(r.fontName)) bold += n;
  });
  return all > 0 && bold / all > 0.5;
}

/**
 * A numbered line is a heading only when what follows its number is short and not a sentence ("2. Scope", not "2. Plan
 * to send the ship on the day most helpful to the partner;"). Unnumbered lines are judged by size alone, as before.
 */
function headingShaped(text: string, marker: ReturnType<typeof detectListMarker>): boolean {
  if (marker === undefined || marker.listKind !== 'ordered') return true;
  const rest = marker.remainder.trim();
  return rest.split(/\s+/).length <= MAX_NUMBERED_HEADING_WORDS && !/[.;,]$/.test(rest);
}
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
