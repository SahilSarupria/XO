import type { TextRun } from '../pdf/content-stream.js';
import { decodeRunText, type FontEncodingResolver } from '../pdf/text-runs-to-plain-text.js';

export interface Line {
  readonly pageNumber: number;
  readonly y: number;
  readonly minX: number;
  readonly maxFontSizePt: number;
  readonly text: string;
  readonly runs: readonly TextRun[];
  /** UW-3b: each run's decoded text, aligned with `runs` (decoded through the page's font encodings). Absent for lines built by hand. */
  readonly runTexts?: readonly string[];
}

/** How close two runs' y-coordinates must be to be considered "the same line" — small enough to not merge genuinely different lines, large enough to absorb the sub-point rounding differences a real content stream's Td/TJ arithmetic can produce. */
const Y_TOLERANCE = 0.5;

/**
 * Per-character advance-width table, expressed in the standard
 * 1000-units-per-em convention (divide by 1000 and multiply by
 * `fontSizePt` to get points) — used only to decide whether two same-line
 * runs are separated by real horizontal space (a different table
 * cell/column, a label followed by its value) or are merely a single word
 * split across runs for `TJ` kerning. This package's content-stream
 * interpreter does not have access to the *specific embedded* font's
 * actual glyph widths (see `content-stream.ts`'s own doc comment), so
 * this table is a standard-metrics approximation, not a glyph-accurate
 * per-document measurement — but it is a real per-character metrics
 * table (Adobe's public-domain Helvetica AFM widths, the same reference
 * table any tool without embedded glyph widths falls back on), not a
 * flat average.
 *
 * A flat `text.length * fontSize * ratio` estimate (the prior
 * implementation) underestimates every run containing wide characters
 * (`m`, `w`, capital letters) relative to narrow ones (`i`, `l`, `.`),
 * because it assigns every character the same width regardless of shape.
 * For a run ending in wide characters, that underestimate makes the next
 * run's true x-position look farther away than it really is, which can
 * push a same-word kerning gap over `GAP_SPACE_THRESHOLD_RATIO` and
 * insert a space in the middle of a word ("amounts" → "am ounts",
 * "Performance" → "Perform ance") — this table fixes that by measuring
 * each character's real relative width instead of assuming they're all
 * equal.
 */
const HELVETICA_CHAR_WIDTHS_PER_1000: Readonly<Record<string, number>> = {
  ' ': 278,
  '!': 278,
  '"': 355,
  '#': 556,
  $: 556,
  '%': 889,
  '&': 667,
  "'": 191,
  '(': 333,
  ')': 333,
  '*': 389,
  '+': 584,
  ',': 278,
  '-': 333,
  '.': 278,
  '/': 278,
  '0': 556,
  '1': 556,
  '2': 556,
  '3': 556,
  '4': 556,
  '5': 556,
  '6': 556,
  '7': 556,
  '8': 556,
  '9': 556,
  ':': 278,
  ';': 278,
  '<': 584,
  '=': 584,
  '>': 584,
  '?': 556,
  '@': 1015,
  A: 667,
  B: 667,
  C: 722,
  D: 722,
  E: 667,
  F: 611,
  G: 778,
  H: 722,
  I: 278,
  J: 500,
  K: 667,
  L: 556,
  M: 833,
  N: 722,
  O: 778,
  P: 667,
  Q: 778,
  R: 722,
  S: 667,
  T: 611,
  U: 722,
  V: 667,
  W: 944,
  X: 667,
  Y: 667,
  Z: 611,
  '[': 278,
  '\\': 278,
  ']': 278,
  '^': 469,
  _: 556,
  '`': 333,
  a: 556,
  b: 556,
  c: 500,
  d: 556,
  e: 556,
  f: 278,
  g: 556,
  h: 556,
  i: 222,
  j: 222,
  k: 500,
  l: 222,
  m: 833,
  n: 556,
  o: 556,
  p: 556,
  q: 556,
  r: 333,
  s: 500,
  t: 278,
  u: 556,
  v: 500,
  w: 722,
  x: 500,
  y: 500,
  z: 500,
  '{': 334,
  '|': 260,
  '}': 334,
  '~': 584,
};

/**
 * Fallback width (per 1000 em) for any character outside the table above
 * (accented Latin, non-Latin scripts, symbols) — Helvetica's own average
 * lowercase width, which errs toward the population's typical glyph width
 * rather than toward either extreme.
 */
const DEFAULT_CHAR_WIDTH_PER_1000 = 556;

/**
 * How large the gap between the estimated end of one run and the start
 * of the next has to be, relative to font size, before it is treated as
 * a real separation and a space is inserted — rather than a kerning-
 * driven split within one word, which is left untouched. Deliberately
 * biased toward inserting a space when the estimate is ambiguous: a
 * spurious extra space (worst case, one token reads as two) is far less
 * harmful downstream than a missing one, which fuses two unrelated
 * words/table cells into a single unreadable token — the concrete defect
 * this constant exists to fix (e.g. a "Name" column header and an
 * "Opted" column header, on the same line with a real gap between them,
 * previously concatenating into the meaningless "NameOpted").
 */
const GAP_SPACE_THRESHOLD_RATIO = 0.25;

/** Absolute floor for the gap threshold, in points, so a pathologically small `fontSizePt` (e.g. a malformed/degenerate content stream) can't make the threshold collapse to ~0 and start inserting a space between every kerned glyph pair. */
const MIN_GAP_SPACE_THRESHOLD_PT = 1;

/** Estimated advance width of a run's text, in points (standard Helvetica metrics; see the table above). */
export function estimateRunAdvanceWidth(text: string, fontSizePt: number): number {
  let totalUnitsPer1000 = 0;
  for (const ch of text) {
    totalUnitsPer1000 += HELVETICA_CHAR_WIDTHS_PER_1000[ch] ?? DEFAULT_CHAR_WIDTH_PER_1000;
  }
  return (totalUnitsPer1000 / 1000) * fontSizePt;
}

/**
 * Joins one line's already left-to-right-sorted runs into its plain
 * text, inserting a single space wherever the horizontal gap between
 * consecutive runs is large enough to indicate a real separation (see
 * `GAP_SPACE_THRESHOLD_RATIO` above) — this is the fix for Stage 2's
 * known concatenation defect: `sortedRuns.map(decodeRunText).join('')`
 * (the prior implementation) trusted content-stream run boundaries as
 * meaningless and concatenated every run on a line with no separator at
 * all, which is correct for a kerning-split word but silently fuses
 * distinct table cells/fields into one token otherwise. Never inserts a
 * *second* space where one already exists on either side of the
 * boundary (a run's decoded text can itself start/end with whitespace).
 */
function joinSameLineRuns(sortedRuns: readonly TextRun[], resolveFontEncoding?: FontEncodingResolver): string {
  let out = '';
  let prevEndX: number | undefined;
  let prevFontSizePt = 0;

  for (const run of sortedRuns) {
    const text = decodeRunText(run, resolveFontEncoding);
    if (text.length === 0) continue;

    if (prevEndX !== undefined) {
      const gap = run.x - prevEndX;
      const threshold = Math.max(MIN_GAP_SPACE_THRESHOLD_PT, GAP_SPACE_THRESHOLD_RATIO * Math.max(prevFontSizePt, run.fontSizePt));
      const alreadySpaced = out.endsWith(' ') || out.endsWith('\n') || text.startsWith(' ');
      if (gap > threshold && !alreadySpaced) {
        out += ' ';
      }
    }

    out += text;
    prevEndX = run.x + estimateRunAdvanceWidth(text, run.fontSizePt);
    prevFontSizePt = run.fontSizePt;
  }

  return out;
}

/**
 * How far, in points, a same-`y` run's `x` is allowed to fall behind the
 * running maximum `x` already placed in that bucket before it is treated
 * as genuinely going backward (a different physical line) rather than
 * ordinary negative-kerning jitter within one line — see
 * `groupRunsIntoLines` below.
 */
const BACKWARD_X_TOLERANCE_PT = 2;

/**
 * Groups a page's already-extracted `TextRun`s (Stage 1) into reading-
 * order lines: same-line runs are sorted left-to-right and joined via
 * `joinSameLineRuns` (which decides, per adjacent run pair, whether a
 * real horizontal gap warrants inserting a space — see above), separate
 * lines are ordered top-to-bottom (PDF y increases upward, so descending
 * `y`). This is the structural foundation `block-classifier.ts` builds
 * heading/paragraph/list/footnote decisions on — no semantic
 * understanding of the text itself happens here.
 *
 * A same-`y` match is necessary but not sufficient for "same physical
 * line": some real-world PDF generators lay each line out inside its own
 * `q`/`cm`/`BT…ET`/`Q` block, positioned by that block's `cm` translation
 * plus a local `Td` offset. When both are derived from the same
 * line-height quantum (a common, entirely valid layout technique), two
 * *unrelated* lines — hundreds of operators apart in the content stream —
 * can transform to the exact same absolute page `y`. A single real
 * printed line is always drawn with non-decreasing `x` (each subsequent
 * text-showing operator advances the line's position forward; the rare
 * negative-kerning step narrows a gap but does not restart the line), so
 * an incoming run is only joined into a `y`-matching bucket if its `x`
 * does not fall meaningfully *behind* the running maximum `x` already
 * placed there (see `BACKWARD_X_TOLERANCE_PT`). A genuine coincidental-`y`
 * collision from an unrelated block restarts at that block's own
 * (typically much smaller) `x`, so it fails this check and is routed to a
 * fresh bucket instead of being merged and character-interleaved by the
 * x-ascending sort below. This is the fix for the character-level
 * corruption Stage 2 could previously produce (e.g. "Identify" merging
 * with an unrelated same-`y` "CRM." into "ICdReMnt.ify") — legitimate
 * same-line kerning and side-by-side content (distinct table columns,
 * runs with increasing `x`) are unaffected, since they never go backward.
 */
function groupRunsIntoLinesSingleFlow(
  pageNumber: number,
  runs: readonly TextRun[],
  resolveFontEncoding?: FontEncodingResolver,
): readonly Line[] {
  const byY: { y: number; runs: TextRun[]; maxX: number }[] = [];
  for (const run of runs) {
    let target: (typeof byY)[number] | undefined;
    for (const candidate of byY) {
      if (Math.abs(candidate.y - run.y) > Y_TOLERANCE) continue;
      if (run.x < candidate.maxX - BACKWARD_X_TOLERANCE_PT) continue;
      target = candidate;
      break;
    }

    if (target) {
      target.runs.push(run);
      target.maxX = Math.max(target.maxX, run.x);
    } else {
      byY.push({ y: run.y, runs: [run], maxX: run.x });
    }
  }

  byY.sort((a, b) => b.y - a.y); // top of page first

  return byY.map((bucket) => {
    const sortedRuns = [...bucket.runs].sort((a, b) => a.x - b.x);
    return {
      pageNumber,
      y: bucket.y,
      minX: Math.min(...sortedRuns.map((r) => r.x)),
      maxFontSizePt: Math.max(...sortedRuns.map((r) => r.fontSizePt)),
      text: joinSameLineRuns(sortedRuns, resolveFontEncoding),
      runs: sortedRuns,
      runTexts: sortedRuns.map((r) => decodeRunText(r, resolveFontEncoding)),
    };
  });
}

// ── Multi-column reading order ───────────────────────────────────────────────────────────────────────────────────────
//
// A page whose prose runs in two columns has, on almost every baseline, text from BOTH columns. Grouping purely by `y`
// merges them into one line and interleaves the columns ("left line 1 right line 1 / left line 2 ..."), which scrambles
// every sentence that crosses a line break. The detector below looks for a vertical gutter that (nearly) no run crosses,
// and only treats the page as columns when BOTH sides are wide, multi-line prose. A table with a narrow id column, a single
// column, or a page with only a few lines is left exactly as before (row-wise order preserved).

/** Fraction of LINES allowed to cross the gutter (a full-width title, a centred page number); at least 2 lines are always tolerated. */
const COLUMN_MAX_CROSSING_LINE_FRACTION = 0.15;
/** Gaps between neighbouring runs of one line up to this size are word spacing, not a gutter. */
const COLUMN_WORD_GAP_BRIDGE_PT = 8;
/** Narrowest empty band, in points, that counts as a gutter. */
const COLUMN_GUTTER_MIN_WIDTH_PT = 14;
/** Each column must be at least this fraction of the page width — excludes tables with a narrow id/label column. */
const COLUMN_MIN_WIDTH_FRACTION = 0.3;
/** Each column must have at least this many distinct text lines. */
const COLUMN_MIN_LINES_PER_SIDE = 4;

export interface RunExtent {
  readonly run: TextRun;
  readonly x0: number;
  readonly x1: number;
}

/** Groups extents into physical lines (same baseline) and merges each line's runs into continuous spans, bridging word gaps. */
function lineSpans(extents: readonly RunExtent[]): { y: number; spans: [number, number][] }[] {
  const lines: { y: number; items: RunExtent[] }[] = [];
  for (const e of extents) {
    const line = lines.find((l) => Math.abs(l.y - e.run.y) <= Y_TOLERANCE);
    if (line) line.items.push(e);
    else lines.push({ y: e.run.y, items: [e] });
  }
  return lines.map((l) => {
    const sorted = [...l.items].sort((a, b) => a.x0 - b.x0);
    const spans: [number, number][] = [];
    for (const e of sorted) {
      const last = spans[spans.length - 1];
      if (last !== undefined && e.x0 - last[1] <= COLUMN_WORD_GAP_BRIDGE_PT) last[1] = Math.max(last[1], e.x1);
      else spans.push([e.x0, e.x1]);
    }
    return { y: l.y, spans };
  });
}

/**
 * Finds the x position of a column gutter, or `undefined` when the page is not a two-column prose layout. A gutter is an
 * empty vertical band that (almost) no LINE crosses once word spacing is bridged, with wide, multi-line text on both sides.
 */
export function detectColumnGutter(extents: readonly RunExtent[], pageWidth: number): number | undefined {
  const lines = lineSpans(extents);
  if (lines.length < 2 * COLUMN_MIN_LINES_PER_SIDE) return undefined;
  const maxCrossing = Math.max(2, Math.floor(lines.length * COLUMN_MAX_CROSSING_LINE_FRACTION));
  let best: { start: number; end: number } | undefined;
  let open: number | undefined;
  const lo = Math.floor(pageWidth * 0.2);
  const hi = Math.ceil(pageWidth * 0.8);
  for (let x = lo; x <= hi + 1; x += 1) {
    const crossing = x <= hi ? lines.filter((l) => l.spans.some(([a, b]) => a <= x && x <= b)).length : maxCrossing + 1;
    if (crossing <= maxCrossing) {
      if (open === undefined) open = x;
    } else if (open !== undefined) {
      if (x - open >= COLUMN_GUTTER_MIN_WIDTH_PT && (best === undefined || x - open > best.end - best.start))
        best = { start: open, end: x };
      open = undefined;
    }
  }
  if (best === undefined) return undefined;
  const mid = (best.start + best.end) / 2;
  const left = extents.filter((e) => e.x1 <= mid);
  const right = extents.filter((e) => e.x0 >= mid);
  if (left.length === 0 || right.length === 0) return undefined;
  const width = (side: readonly RunExtent[]): number => Math.max(...side.map((e) => e.x1)) - Math.min(...side.map((e) => e.x0));
  if (width(left) < COLUMN_MIN_WIDTH_FRACTION * pageWidth || width(right) < COLUMN_MIN_WIDTH_FRACTION * pageWidth) return undefined;
  if (lineSpans(left).length < COLUMN_MIN_LINES_PER_SIDE || lineSpans(right).length < COLUMN_MIN_LINES_PER_SIDE) return undefined;
  return mid;
}

/**
 * Groups a page's runs into reading-ordered lines. With `pageWidth`, a detected two-column prose layout is read column by
 * column (a full-width run above the columns first, then the whole left column, then the whole right column, then
 * full-width runs below). Without it, or when no column layout is detected, behaviour is the single-flow grouping above.
 */
export function groupRunsIntoLines(
  pageNumber: number,
  runs: readonly TextRun[],
  resolveFontEncoding?: FontEncodingResolver,
  pageWidth?: number,
): readonly Line[] {
  if (pageWidth === undefined || pageWidth <= 0) return groupRunsIntoLinesSingleFlow(pageNumber, runs, resolveFontEncoding);
  const extents: RunExtent[] = runs
    .map((run) => ({ run, text: decodeRunText(run, resolveFontEncoding) }))
    .filter((r) => r.text.trim().length > 0)
    .map((r) => ({ run: r.run, x0: r.run.x, x1: r.run.x + estimateRunAdvanceWidth(r.text, r.run.fontSizePt) }));
  const gutter = detectColumnGutter(extents, pageWidth);
  if (gutter === undefined) return groupRunsIntoLinesSingleFlow(pageNumber, runs, resolveFontEncoding);

  const leftRuns: TextRun[] = [];
  const rightRuns: TextRun[] = [];
  const spanningRuns: TextRun[] = [];
  for (const e of extents) (e.x1 <= gutter ? leftRuns : e.x0 >= gutter ? rightRuns : spanningRuns).push(e.run);
  const left = groupRunsIntoLinesSingleFlow(pageNumber, leftRuns, resolveFontEncoding);
  const right = groupRunsIntoLinesSingleFlow(pageNumber, rightRuns, resolveFontEncoding);
  const spanning = groupRunsIntoLinesSingleFlow(pageNumber, spanningRuns, resolveFontEncoding);
  const columnTop = Math.max(...[...left, ...right].map((l) => l.y));
  return [...spanning.filter((l) => l.y > columnTop), ...left, ...right, ...spanning.filter((l) => l.y <= columnTop)];
}
