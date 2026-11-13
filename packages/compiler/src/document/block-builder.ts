import { decodedRuns, type ClassifiedLine } from './block-classifier.js';
import type { DocumentBlock, Provenance } from './types.js';
import { decodeRunText } from '../pdf/text-runs-to-plain-text.js';
import { estimateRunAdvanceWidth } from './line-grouper.js';

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

/** A two-column grid is only trusted when its header row names a decision-bearing term (limit, excess, waiting period, ...): alignment alone cannot tell a grid from a label/value list (a warranty grid in burglary-policy.pdf is extracted as prose today and must stay so). */
const TWO_COLUMN_HEADER =
  /\b(limit|sub-?limit|excess|deductible|co-?pay(?:ment)?|co-?insurance|maximum|minimum|sum insured|waiting|period|days|deadline|grace)\b/i;
const MAX_GRID_CELL_WORDS = 6;

/**
 * Header-anchored two-column grid ("Peril | Waiting period" followed by rows). Returns the exclusive end line of a
 * grid that starts at `start`, or `start` when none does. Needs the same `MIN_TABLE_ROWS` aligned consecutive lines as
 * any table, a header whose second cell names a decision-bearing term, and short cells in every row (a wrapped prose
 * clause is not a grid cell).
 */
function twoColumnGridEnd(lines: readonly ClassifiedLine[], start: number): number {
  const head = lines[start]!;
  if (head.runs.length !== 2) return start;
  const headCells = head.runs.map((r) => decodeRunText(r).trim());
  if (!TWO_COLUMN_HEADER.test(headCells[1]!)) return start;
  const xs = head.runs.map((r) => r.x);
  let j = start;
  while (j < lines.length) {
    const line = lines[j]!;
    if (line.pageNumber !== head.pageNumber || line.runs.length !== 2) break;
    if (!line.runs.every((r, k) => Math.abs(r.x - xs[k]!) < COLUMN_X_TOLERANCE)) break;
    if (line.runs.some((r) => decodeRunText(r).trim().split(/\s+/).length > MAX_GRID_CELL_WORDS)) break;
    j += 1;
  }
  return j - start >= MIN_TABLE_ROWS ? j : start;
}

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
    const grid = twoColumnGridEnd(lines, i);
    if (grid > i) {
      for (let k = i; k < grid; k += 1) tableLineIndices.add(k);
      i = grid;
      continue;
    }
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
    // UW-3b: two text runs that start at the same x are one column whose font changes mid-line (a bold title, then its
    // body), not two cells — no table puts two cells at one position. A group in which EVERY line is like that, and so
    // has fewer than MIN_TABLE_COLUMNS real columns, is a marker-plus-text list ("1 | Never commit secrets. API keys
    // ..."), which block-classifier.ts reads as list items. Blank runs are ignored either way, as before.
    const sharedTextColumn = (line: ClassifiedLine): boolean => {
      const runs = decodedRuns(line);
      return (
        runs.some((r, k) => k > 0 && Math.abs(r.x - runs[k - 1]!.x) <= COLUMN_X_TOLERANCE) && cellsOfLine(line).length < MIN_TABLE_COLUMNS
      );
    };
    const markerPlusText = j - i >= MIN_TABLE_ROWS && lines.slice(i, j).every(sharedTextColumn);
    if (j - i >= MIN_TABLE_ROWS && !markerPlusText) {
      for (let k = i; k < j; k += 1) tableLineIndices.add(k);
      i = j;
    } else {
      i += 1;
    }
  }
  return tableLineIndices;
}

// ── UW-3b: tables whose cells wrap ─────────────────────────────────────────────────────────────────────────────────
//
// `detectTableRowLines` needs every row on one physical line. Real tables wrap long cells, so one logical row spans
// several lines with different run counts and it falls through to prose, where the columns interleave ("List inputs,
// Goal is clear and written outputs, and constraints. down"). This reconstructs such a table from geometry alone:
//
//   header   a line of at least MIN_TABLE_COLUMNS short label cells at distinct x positions → the column starts;
//   row      a following line whose runs all start at column starts and that has text in the FIRST column;
//   wrapped  a line whose runs all start at column starts, with nothing in the first column, a wrapped-line gap below
//            the line above → appended, cell by cell, to the row above.
//
// It is all or nothing: if a line inside the region breaks a rule (a first-column-less line that is not a tight
// continuation, a run between columns), the whole candidate is rejected and the lines stay exactly as before. At least
// two rows and at least one wrapped line are required, so a single-line table is left to `detectTableRowLines` and
// anything else to ordinary prose. Same page only.

const MAX_HEADER_CELL_WORDS = 5;
const MAX_HEADER_CELL_CHARS = 40;
const MIN_WRAPPED_ROWS = 2;
/** Same rule the paragraph builder uses for a wrapped line versus a new paragraph. */
const WRAPPED_LINE_GAP_MULTIPLIER = PARAGRAPH_BREAK_GAP_MULTIPLIER;

export interface ReconstructedTable {
  readonly header: { readonly line: number; readonly cells: readonly string[] };
  readonly rows: readonly { readonly lines: readonly number[]; readonly cells: readonly string[] }[];
  /** Every line index the table claims (header, rows and their wrapped lines). */
  readonly lines: readonly number[];
}

/** Runs of a line merged into cells: runs at the same x, or flowing straight on from the previous run, are one cell. */
function cellsOfLine(line: ClassifiedLine): { readonly x: number; readonly text: string }[] {
  const out: { x: number; text: string }[] = [];
  let prevEnd = Number.NEGATIVE_INFINITY;
  for (const r of decodedRuns(line)) {
    const last = out[out.length - 1];
    if (last !== undefined && (Math.abs(r.x - last.x) <= COLUMN_X_TOLERANCE || (r.x >= last.x && r.x - prevEnd <= 4))) {
      last.text = `${last.text}${r.text}`;
    } else {
      out.push({ x: r.x, text: r.text });
    }
    prevEnd = Math.max(prevEnd, r.x + estimateRunAdvanceWidth(r.text, r.fontSizePt));
  }
  return out.map((c) => ({ x: c.x, text: c.text.replace(/\s+/g, ' ').trim() })).filter((c) => c.text.length > 0);
}

function isHeaderCell(text: string): boolean {
  if (text.length > MAX_HEADER_CELL_CHARS) return false;
  if (text.split(/\s+/).length > MAX_HEADER_CELL_WORDS) return false;
  return !/[.;,]$/.test(text);
}

function columnOf(x: number, columns: readonly number[]): number | undefined {
  const k = columns.findIndex((c) => Math.abs(c - x) <= COLUMN_X_TOLERANCE);
  return k < 0 ? undefined : k;
}

function joinCellText(a: string, b: string): string {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  // A word broken across lines with a hyphen ("re-" / "test") is rejoined; a real hyphenated word keeps its hyphen.
  return a.endsWith('-') && /^[a-z]/.test(b) ? `${a}${b}` : `${a} ${b}`;
}

function wrappedTableAt(
  lines: readonly ClassifiedLine[],
  start: number,
  claimed: ReadonlySet<number>,
  bodySize: number,
): ReconstructedTable | undefined {
  const head = lines[start]!;
  if (head.blockKind === 'heading') return undefined;
  const headerCells = cellsOfLine(head);
  if (headerCells.length < MIN_TABLE_COLUMNS) return undefined;
  if (!headerCells.every((c) => isHeaderCell(c.text))) return undefined;
  if (headerCells.filter((c) => /\p{L}/u.test(c.text)).length < 2) return undefined;
  const columns = headerCells.map((c) => c.x);
  for (let k = 1; k < columns.length; k += 1) if (columns[k]! - columns[k - 1]! <= 2 * COLUMN_X_TOLERANCE) return undefined;

  const rows: { lines: number[]; cells: string[] }[] = [];
  let continuationCount = 0;
  let previousY = head.y;
  let j = start + 1;
  for (; j < lines.length; j += 1) {
    const line = lines[j]!;
    if (line.pageNumber !== head.pageNumber || claimed.has(j) || line.blockKind === 'heading' || line.blockKind === 'footnote') break;
    const cells = cellsOfLine(line);
    if (cells.length === 0) continue;
    const placed = cells.map((c) => ({ column: columnOf(c.x, columns), text: c.text }));
    if (placed.some((p) => p.column === undefined)) break; // a run between columns: the table (if any) ended above
    const gap = previousY - line.y;
    const startsRow = placed.some((p) => p.column === 0);
    if (startsRow) {
      const rowCells = columns.map(() => '');
      for (const p of placed) rowCells[p.column!] = joinCellText(rowCells[p.column!]!, p.text);
      rows.push({ lines: [j], cells: rowCells });
    } else {
      const current = rows[rows.length - 1];
      if (current === undefined || gap <= 0 || gap > bodySize * WRAPPED_LINE_GAP_MULTIPLIER) return undefined; // not a clean wrap: reject the whole table
      for (const p of placed) current.cells[p.column!] = joinCellText(current.cells[p.column!]!, p.text);
      current.lines.push(j);
      continuationCount += 1;
    }
    previousY = line.y;
  }
  if (rows.length < MIN_WRAPPED_ROWS || continuationCount === 0) return undefined;
  if (!rows.every((r) => r.cells.filter((c) => c.length > 0).length >= 2)) return undefined;
  return {
    header: { line: start, cells: headerCells.map((c) => c.text) },
    rows,
    lines: [start, ...rows.flatMap((r) => r.lines)],
  };
}

/** UW-3b: every wrapped table in the line stream (see above), skipping lines `claimed` by the single-line table detector. */
export function detectWrappedTables(
  lines: readonly ClassifiedLine[],
  claimed: ReadonlySet<number>,
  bodySize: number,
): readonly ReconstructedTable[] {
  const tables: ReconstructedTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const table = claimed.has(i) ? undefined : wrappedTableAt(lines, i, claimed, bodySize);
    if (table === undefined) {
      i += 1;
      continue;
    }
    tables.push(table);
    i = Math.max(...table.lines) + 1;
  }
  return tables;
}

// ── UW-3b: fill-in forms ──────────────────────────────────────────────────────────────────────────────────────────────
//
// A form prints labels in one column and leaves the value column blank, or shows a hint or the options there:
//   Task title
//   Task type      Feature / Bug fix / Refactor / Docs / Other
//   Owner
// Read as prose these lines became rules ("Out of scope What will NOT be done in this task?" as an obligation). A
// region is a form only when it has at least MIN_FORM_FIELDS consecutive lines, all labels start at one x and every
// value at one other x, labels are short, AND at least one label has no value (a blank to fill in). A label/value
// list where every value is filled in is a record of data, not a form, and is left exactly as before.

const MIN_FORM_FIELDS = 3;
const MAX_FORM_LABEL_WORDS = 6;
/** Fields of one form sit at most this many body-line heights apart (forms leave room to write). */
const MAX_FORM_FIELD_GAP_MULTIPLIER = 4;

export interface FormField {
  readonly line: number;
  readonly label: string;
  readonly hint?: string;
}

function formRegionAt(
  lines: readonly ClassifiedLine[],
  start: number,
  claimed: ReadonlySet<number>,
  bodySize: number,
): readonly FormField[] | undefined {
  const first = lines[start]!;
  if (first.blockKind !== 'paragraph' || claimed.has(start)) return undefined;
  const fields: FormField[] = [];
  let labelX: number | undefined;
  let valueX: number | undefined;
  let previousY: number | undefined;
  for (let j = start; j < lines.length; j += 1) {
    const line = lines[j]!;
    if (line.pageNumber !== first.pageNumber || claimed.has(j) || line.blockKind !== 'paragraph') break;
    if (previousY !== undefined && (previousY - line.y <= 0 || previousY - line.y > bodySize * MAX_FORM_FIELD_GAP_MULTIPLIER)) break;
    const cells = cellsOfLine(line);
    if (cells.length === 0 || cells.length > 2) break;
    const label = cells[0]!;
    if (labelX === undefined) labelX = label.x;
    if (Math.abs(label.x - labelX) > COLUMN_X_TOLERANCE) break;
    if (label.text.split(/\s+/).length > MAX_FORM_LABEL_WORDS || /[.;]$/.test(label.text)) break;
    const value = cells[1];
    if (value !== undefined) {
      if (valueX === undefined) valueX = value.x;
      if (Math.abs(value.x - valueX) > COLUMN_X_TOLERANCE || value.x - label.x <= 2 * COLUMN_X_TOLERANCE) break;
    }
    fields.push({ line: j, label: label.text, ...(value !== undefined ? { hint: value.text } : {}) });
    previousY = line.y;
  }
  if (fields.length < MIN_FORM_FIELDS || valueX === undefined) return undefined;
  if (!fields.some((f) => f.hint === undefined)) return undefined; // every value filled in: data, not a form
  return fields;
}

/** UW-3b: the fields of every fill-in form in the line stream (see above). */
export function detectFormFields(
  lines: readonly ClassifiedLine[],
  claimed: ReadonlySet<number>,
  bodySize: number,
): ReadonlyMap<number, FormField> {
  const out = new Map<number, FormField>();
  let i = 0;
  while (i < lines.length) {
    const fields = formRegionAt(lines, i, claimed, bodySize);
    if (fields === undefined) {
      i += 1;
      continue;
    }
    for (const f of fields) out.set(f.line, f);
    i = fields[fields.length - 1]!.line + 1;
  }
  return out;
}

/** UW-3b: a line whose runs sit in separate columns (a gap far wider than word spacing) — joined as prose, its meaning may be garbled. */
export function hasColumnGap(line: ClassifiedLine): boolean {
  const runs = decodedRuns(line);
  for (let k = 1; k < runs.length; k += 1) {
    const prev = runs[k - 1]!;
    const end = prev.x + estimateRunAdvanceWidth(prev.text, prev.fontSizePt);
    if (runs[k]!.x - end > Math.max(COLUMN_GAP_MIN_PT, COLUMN_GAP_FONT_MULTIPLIER * prev.fontSizePt)) return true;
  }
  return false;
}
const COLUMN_GAP_MIN_PT = 20;
const COLUMN_GAP_FONT_MULTIPLIER = 2;

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
  // UW-3b: wrapped-cell tables and fill-in forms, each claiming only lines no earlier detector took.
  const wrappedTables = detectWrappedTables(lines, tableLineIndices, bodySize);
  const wrappedRowAt = new Map<number, { cells: readonly string[]; lines: readonly number[] }>();
  const wrappedLines = new Set<number>();
  for (const t of wrappedTables) {
    wrappedRowAt.set(t.header.line, { cells: t.header.cells, lines: [t.header.line] });
    for (const r of t.rows) wrappedRowAt.set(r.lines[0]!, r);
    for (const l of t.lines) wrappedLines.add(l);
  }
  const formFields = detectFormFields(lines, new Set([...tableLineIndices, ...wrappedLines]), bodySize);

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) return;
    const suspect = paragraphBuffer.some(hasColumnGap);
    blocks.push({
      kind: 'paragraph',
      text: paragraphBuffer.map((l) => l.text).join(' '),
      provenance: provenanceOf(paragraphBuffer),
      ...(suspect ? { layoutSuspect: true as const } : {}),
    });
    paragraphBuffer = [];
  };

  const flushHeading = (): void => {
    if (headingBuffer.length === 0) return;
    blocks.push({
      kind: 'heading',
      level: headingBuffer[0]!.headingLevel!,
      text: headingBuffer.map((l) => l.text).join(' '),
      provenance: provenanceOf(headingBuffer),
    });
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

    if (wrappedLines.has(index)) {
      flushParagraph();
      flushHeading();
      const row = wrappedRowAt.get(index);
      if (row !== undefined) {
        blocks.push({
          kind: 'table_row',
          cells: row.cells,
          provenance: provenanceOf(row.lines.map((l) => lines[l]!)),
          reconstruction: 'wrapped',
        });
      }
      continue; // a wrapped line is already part of its row
    }

    const field = formFields.get(index);
    if (field !== undefined) {
      flushParagraph();
      flushHeading();
      blocks.push({
        kind: 'paragraph',
        text: line.text,
        provenance: provenanceOf([line]),
        formField: { label: field.label, ...(field.hint !== undefined ? { hint: field.hint } : {}) },
      });
      continue;
    }

    // UW-3b: the wrapped tail of a marker-led list item (block-classifier.ts) belongs to that item.
    if (line.listContinuation === true) {
      const last = blocks[blocks.length - 1];
      if (paragraphBuffer.length === 0 && headingBuffer.length === 0 && last !== undefined && last.kind === 'list_item') {
        const extra = line.text.trim();
        blocks[blocks.length - 1] = {
          ...last,
          text: `${last.text} ${extra}`,
          ...(last.body !== undefined ? { body: `${last.body} ${extra}` } : {}),
          provenance: { page: last.provenance.page, yRange: [last.provenance.yRange[0], Math.min(last.provenance.yRange[1], line.y)] },
        };
        continue;
      }
    }

    if (line.blockKind === 'paragraph') {
      flushHeading();
      const prev = paragraphBuffer[paragraphBuffer.length - 1];
      const gapTooLarge =
        prev !== undefined && (prev.pageNumber !== line.pageNumber || prev.y - line.y > bodySize * PARAGRAPH_BREAK_GAP_MULTIPLIER);
      const gapTooSmall = prev !== undefined && prev.pageNumber === line.pageNumber && prev.y - line.y < MIN_LINE_GAP_PT;
      if (gapTooLarge || gapTooSmall) flushParagraph();
      paragraphBuffer.push(line);
      continue;
    }

    flushParagraph();

    if (line.blockKind === 'heading') {
      const prev = headingBuffer[headingBuffer.length - 1];
      const gapTooLarge =
        prev !== undefined &&
        (prev.pageNumber !== line.pageNumber ||
          prev.y - line.y > bodySize * PARAGRAPH_BREAK_GAP_MULTIPLIER ||
          prev.headingLevel !== line.headingLevel);
      const gapTooSmall = prev !== undefined && prev.pageNumber === line.pageNumber && prev.y - line.y < MIN_LINE_GAP_PT;
      if (gapTooLarge || gapTooSmall) flushHeading();
      headingBuffer.push(line);
      continue;
    }

    flushHeading();

    if (line.blockKind === 'list_item') {
      blocks.push({
        kind: 'list_item',
        marker: line.listMarker!,
        listKind: line.listKind!,
        text: line.listText ?? line.text,
        provenance: provenanceOf([line]),
        ...(line.checkbox !== undefined ? { checkbox: line.checkbox } : {}),
        ...(line.ordinal !== undefined ? { ordinal: line.ordinal } : {}),
        ...(line.itemTitle !== undefined && line.itemBody !== undefined ? { title: line.itemTitle, body: line.itemBody } : {}),
      });
    } else if (line.blockKind === 'footnote') {
      blocks.push({ kind: 'footnote', text: line.text, provenance: provenanceOf([line]) });
    }
  }
  flushParagraph();
  flushHeading();

  return blocks;
}
