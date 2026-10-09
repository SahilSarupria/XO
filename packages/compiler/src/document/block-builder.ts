import type { ClassifiedLine } from './block-classifier.js';
import type { DocumentBlock, Provenance } from './types.js';
import { decodeRunText } from '../pdf/text-runs-to-plain-text.js';

/** How much larger a line-to-line y-gap has to be, relative to the body font size, before it's treated as a paragraph break rather than a wrapped line within the same paragraph. An approximation — see this package's README, "Known limitations." */
const PARAGRAPH_BREAK_GAP_MULTIPLIER = 1.6;

/**
 * Minimum downward y-step, in points, between two consecutive
 * paragraph/heading lines for them to be considered a genuine wrapped
 * continuation. A real line of running text is always strictly below the
 * one before it (text flows downward on the page); a gap at or near zero
 * cannot be a real continuation, only two *different* physical lines that
 * coincidentally transform to (approximately) the same page y — the same
 * per-block-quantized-line-height coincidence line-grouper.ts's
 * `groupRunsIntoLines` guards against for glyph ordering within one line.
 * `groupRunsIntoLines` already keeps such lines as separate `Line`
 * objects; without this check, that separation was undone right back
 * here by merging them into one paragraph anyway (e.g. "Channel-wise
 * revenue generation (...)." from one bullet gluing onto "validated
 * reconciliation data." from an unrelated, non-adjacent bullet, both
 * landing at the same y in the real Aastha.pdf fixture).
 */
const MIN_LINE_GAP_PT = 0.5;

/** Minimum number of runs (candidate columns) a line must have before it is even considered as part of a table — two runs is indistinguishable from an ordinary "label ... trailing value" clause (e.g. "1.1 Deductible means the amount... in the Schedule" has 1 run; "Sum Insured Basis Opted    Market Value" has 2 and is NOT a table, just a label-value line), so this alone is not sufficient signal — see `detectTableGroups`'s doc comment for the full multi-signal requirement. */
const MIN_TABLE_COLUMNS = 3;

/** Minimum number of consecutive lines that must share the same column count and alignment before the group is trusted as a table. Two matching lines is still plausible coincidence (e.g. two consecutive clauses that each happen to end in a short aligned value); three is the smallest run this package treats as deliberate, repeated tabular structure rather than a coincidence — see this package's README, "Known limitations," for why table detection stayed unimplemented until this evidence was gathered (P0.9A area C). */
const MIN_TABLE_ROWS = 3;

/** How close two runs' x-coordinates must be to be considered "the same column start" — small enough that two genuinely different column positions are never merged, large enough to absorb the sub-point rounding a real content stream's positioning can produce. Same order of magnitude as `line-grouper.ts`'s `Y_TOLERANCE`, applied to the perpendicular axis. */
const COLUMN_X_TOLERANCE = 3;

/**
 * P0.9A area C (Table Detection + Quarantine).
 *
 * Identifies runs of consecutive lines that are structurally a table,
 * using only signal already computed upstream (`line-grouper.ts`'s
 * per-run x-positions) — no new extraction pass, no PDF-specific
 * assumption beyond what `ClassifiedLine.runs` already carries for every
 * source that produces lines this way.
 *
 * Deliberately conservative, per this milestone's explicit safety
 * requirement: multiple spaces, numbers, punctuation, short lines,
 * capitalization, repeated words, indentation, and list markers are each
 * individually insufficient and are NOT checked here at all. The only
 * signal used is genuine multi-column *repetition*: a line qualifies only
 * as part of a group of `MIN_TABLE_ROWS` or more *consecutive* lines that
 * all have the *same* number of runs (at least `MIN_TABLE_COLUMNS`) at
 * *matching* x-positions (within `COLUMN_X_TOLERANCE`). A single aligned
 * line, or two, is not enough — this is what keeps a numbered clause
 * ending in a short value ("1.1 Deductible means the amount stated in
 * the Schedule...") or a label/value line ("Sum Insured Basis Opted
 * Market Value") from ever qualifying: both are one or two runs, and
 * even a genuine two-line coincidence still falls one line short of
 * `MIN_TABLE_ROWS`. Confirmed empirically against every PDF fixture this
 * package has: zero groups detected in either pure-prose fixture
 * (`Aastha.pdf`, `XO_Commercial_Property_Test_Policy_Compatible.pdf`),
 * and several genuine tables correctly detected in `burglary-policy.pdf`
 * (a Sum-Insured breakdown, and two premium-calculation tables) — see
 * `block-builder.test.ts` for the fixture-backed regression tests this
 * threshold is pinned against.
 *
 * Known, accepted limitation, consistent with "prefer quarantine over
 * speculative interpretation": a table whose cells wrap across multiple
 * physical lines (confirmed present in `burglary-policy.pdf`'s own
 * "Partner Code and Partner Contact..." grid) does not produce a uniform
 * run count per line and is NOT detected — it is left as ordinary
 * paragraph text, exactly the same as today, rather than guessed at.
 * This is the correct trade-off per this milestone's stated preference:
 * a missed table is silently identical to today's behavior; a
 * false-positive table would newly withhold real prose content from
 * extraction.
 *
 * Returns the set of line indices (into `lines`) that belong to a
 * detected table group.
 */
export function detectTableRowLines(lines: readonly ClassifiedLine[]): ReadonlySet<number> {
  const tableLineIndices = new Set<number>();
  let i = 0;
  while (i < lines.length) {
    const base = lines[i]!;
    if (base.runs.length < MIN_TABLE_COLUMNS) {
      i += 1;
      continue;
    }
    const baseXs = base.runs.map((r) => r.x);
    let j = i + 1;
    while (j < lines.length) {
      const candidate = lines[j]!;
      if (candidate.pageNumber !== base.pageNumber) break;
      if (candidate.runs.length !== baseXs.length) break;
      const aligned = candidate.runs.every((r, k) => Math.abs(r.x - baseXs[k]!) < COLUMN_X_TOLERANCE);
      if (!aligned) break;
      j += 1;
    }
    if (j - i >= MIN_TABLE_ROWS) {
      for (let k = i; k < j; k += 1) tableLineIndices.add(k);
      i = j;
    } else {
      i += 1;
    }
  }
  return tableLineIndices;
}

function provenanceOf(lines: readonly ClassifiedLine[]): Provenance {
  const ys = lines.map((l) => l.y);
  return { page: lines[0]!.pageNumber, yRange: [Math.max(...ys), Math.min(...ys)] };
}

/**
 * Converts the flat, classified line stream (block-classifier.ts) into
 * `DocumentBlock`s: consecutive `paragraph`-classified lines on the same
 * page with a small enough y-gap between them are merged into one
 * `ParagraphBlock` (a wrapped line, not a new paragraph); consecutive
 * `heading`-classified lines of the *same heading level*, on the same
 * page, with a small enough y-gap, are merged the same way into one
 * `HeadingBlock` — a heading whose text is too wide for one PDF text line
 * (a long section title) is still a single heading, not one real heading
 * followed by a second, spurious one. Before this merge existed, a
 * wrapped heading produced two `HeadingBlock`s, and `section-builder.ts`
 * (which opens a new `DocumentSection` per heading, no further
 * classification) turned the second fragment into its own junk section —
 * concretely, a heading like "GRIEVANCE REDRESSAL PROCESS" wrapping after
 * "REDRESSAL" produced a standalone section titled just "PROCESS". Every
 * other classified line still becomes its own block. Table detection
 * (P0.9A area C) runs as a separate, conservative pre-pass —
 * `detectTableRowLines`, above — over the whole line stream before this
 * loop, and takes precedence over paragraph/heading/list-item
 * classification for any line it claims: see that function's own doc
 * comment for exactly what it requires before classifying a line as
 * tabular, and this package's README, "Known limitations," for what it
 * deliberately still does not attempt (a table whose cells wrap across
 * multiple physical lines).
 */
export function buildBlocks(lines: readonly ClassifiedLine[], bodySize: number): readonly DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let paragraphBuffer: ClassifiedLine[] = [];
  let headingBuffer: ClassifiedLine[] = [];
  // P0.9A area C: computed once up front over the whole line stream, since
  // the detector needs to see runs of consecutive lines regardless of
  // which `blockKind` `block-classifier.ts` assigned each one — a table
  // row whose text happens to start with a number ("1.", "a.") is
  // otherwise indistinguishable, at the classifier stage, from a genuine
  // numbered list item.
  const tableLineIndices = detectTableRowLines(lines);

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraphBuffer.map((l) => l.text).join(' '), provenance: provenanceOf(paragraphBuffer) });
    paragraphBuffer = [];
  };

  const flushHeading = (): void => {
    if (headingBuffer.length === 0) return;
    blocks.push({ kind: 'heading', level: headingBuffer[0]!.headingLevel!, text: headingBuffer.map((l) => l.text).join(' '), provenance: provenanceOf(headingBuffer) });
    headingBuffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    if (tableLineIndices.has(index)) {
      flushParagraph();
      flushHeading();
      blocks.push({ kind: 'table_row', cells: line.runs.map((r) => decodeRunText(r).trim()), provenance: provenanceOf([line]) });
      continue;
    }

    if (line.blockKind === 'paragraph') {
      flushHeading();
      const prev = paragraphBuffer[paragraphBuffer.length - 1];
      const gapTooLarge = prev !== undefined && (prev.pageNumber !== line.pageNumber || prev.y - line.y > bodySize * PARAGRAPH_BREAK_GAP_MULTIPLIER);
      const gapTooSmall = prev !== undefined && prev.pageNumber === line.pageNumber && prev.y - line.y < MIN_LINE_GAP_PT;
      if (gapTooLarge || gapTooSmall) flushParagraph();
      paragraphBuffer.push(line);
      continue;
    }

    flushParagraph();

    if (line.blockKind === 'heading') {
      const prev = headingBuffer[headingBuffer.length - 1];
      const gapTooLarge = prev !== undefined && (prev.pageNumber !== line.pageNumber || prev.y - line.y > bodySize * PARAGRAPH_BREAK_GAP_MULTIPLIER || prev.headingLevel !== line.headingLevel);
      const gapTooSmall = prev !== undefined && prev.pageNumber === line.pageNumber && prev.y - line.y < MIN_LINE_GAP_PT;
      if (gapTooLarge || gapTooSmall) flushHeading();
      headingBuffer.push(line);
      continue;
    }

    flushHeading();

    if (line.blockKind === 'list_item') {
      blocks.push({ kind: 'list_item', marker: line.listMarker!, listKind: line.listKind!, text: line.listText ?? line.text, provenance: provenanceOf([line]) });
    } else if (line.blockKind === 'footnote') {
      blocks.push({ kind: 'footnote', text: line.text, provenance: provenanceOf([line]) });
    }
  }
  flushParagraph();
  flushHeading();

  return blocks;
}
