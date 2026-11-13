/**
 * UW-3c — PDF and OCR layout as real documents print it: wrapped list items, nesting by indentation, numbered lines that
 * are sentences, bold labels between items, per-glyph bullets, right-aligned and centred table columns, and scanned pages
 * whose headings and bullets have to be recovered from layout.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlocks, detectTableRowLines, detectWrappedTables } from '../../src/document/block-builder.js';
import { classifyLines, type ClassifiedLine, type PageForClassification } from '../../src/document/block-classifier.js';
import type { Line } from '../../src/document/line-grouper.js';
import type { DocumentBlock } from '../../src/document/types.js';
import { normalizeRecoveredLines } from '../../src/extraction/adapters/tesseract.js';

type Cell = readonly [x: number, text: string, font?: string];

function line(cells: readonly Cell[], y: number, opts: { page?: number; size?: number } = {}): Line {
  const size = opts.size ?? 10;
  return {
    pageNumber: opts.page ?? 1,
    y,
    minX: cells[0]![0],
    maxFontSizePt: size,
    text: cells.map(([, t]) => t).join(' '),
    runs: cells.map(([x, text, font]) => ({ bytes: Buffer.from(text, 'latin1'), fontName: font, fontSizePt: size, x, y })),
    runTexts: cells.map(([, t]) => t),
  };
}

function blocksOf(lines: readonly Line[], page: Partial<PageForClassification> = {}, bodySize = 10): DocumentBlock[] {
  const classified = classifyLines([{ pageNumber: 1, mediaBox: [0, 0, 600, 800], lines, ...page }], bodySize, [12, 14]);
  return buildBlocks(classified, bodySize);
}

const brief = (b: DocumentBlock): string =>
  b.kind === 'list_item'
    ? `${b.listKind === 'ordered' ? b.ordinal : '-'}@${b.depth ?? '-'} ${b.text}`
    : b.kind === 'heading'
      ? `h ${b.text}`
      : b.kind === 'table_row'
        ? `| ${b.cells.join(' | ')}`
        : `p ${b.text}`;

test('a numbered item wraps onto the item text column, or back to its marker when the line stops mid-sentence', () => {
  const r = blocksOf([
    line([[50, '1. Plan to send the ship on the day most helpful to the partner; probably Friday or']], 700),
    line([[64, 'Monday.']], 688),
    line([[50, '2. This policy is subject to the standard policy wordings as per']], 670),
    line([[50, 'Digit Burglary Insurance Policy.']], 658),
    line([[50, '3. The coverage applies and the policy is not']], 640),
    line([[50, '    valid, if any of the information is incorrect.']], 628),
    line([[50, '4. Total Sum Insured of the Property INR 450000']], 610),
    line([[50, 'Sr. no Details Total Sum Insured (INR)']], 598),
  ]);
  assert.deepEqual(r.map(brief), [
    '1@- Plan to send the ship on the day most helpful to the partner; probably Friday or Monday.',
    '2@- This policy is subject to the standard policy wordings as per Digit Burglary Insurance Policy.',
    '3@- The coverage applies and the policy is not valid, if any of the information is incorrect.',
    '4@- Total Sum Insured of the Property INR 450000',
    'p Sr. no Details Total Sum Insured (INR)',
  ]);
});

test('a bold label after a regular item is its own line, not the item’s continuation', () => {
  const r = blocksOf([
    line([[50, '• [When a lack of a decision could lead to a risk, request a decision', 'Arial']], 700),
    line([[50, 'Risks/blockers', 'Arial-Bold']], 680),
  ]);
  assert.deepEqual(r.map(brief), ['-@- [When a lack of a decision could lead to a risk, request a decision', 'p Risks/blockers']);
});

test('a marker printed on a line of its own (a per-glyph bullet) takes the text on the next line', () => {
  const r = blocksOf([line([[60, '○']], 700), line([[72, 'Reconcile invoice amounts vs. receipt amounts received from insurers.']], 690)]);
  assert.deepEqual(r.map(brief), ['-@- Reconcile invoice amounts vs. receipt amounts received from insurers.']);
});

test('a numbered line set larger is a heading only when it is short: "2. Scope" yes, a numbered sentence no', () => {
  const r = blocksOf([
    line([[50, '2. Scope']], 700, { size: 12 }),
    line([[50, '3. Plan to send the ship on the day most helpful to the partner.']], 680, { size: 12 }),
  ]);
  assert.deepEqual(r.map(brief), ['h 2. Scope', '3@- Plan to send the ship on the day most helpful to the partner.']);
});

test('nesting comes from indentation: marker positions cluster into levels, and a page break starts afresh', () => {
  const r = blocksOf([
    line([[50, '5. Fill in its sections.']], 700),
    line([[72, 'a. Focus on outcomes.']], 686),
    line([[73, 'b. Consider the audience.']], 672),
    line([[49, '6. Paste the ship into an email.']], 658),
  ]);
  assert.deepEqual(r.map(brief), [
    '5@0 Fill in its sections.',
    '1@1 Focus on outcomes.',
    '2@1 Consider the audience.',
    '6@0 Paste the ship into an email.',
  ]);
});

test('a right-aligned amount column and a centred code column still make a table', () => {
  // Amounts end at x=300 (right-aligned); codes are centred on x=400. Left edges are where Helvetica widths put them.
  const lines = [
    line(
      [
        [50, 'Item'],
        [265.5, 'Amount'],
        [388, 'Code'],
      ],
      700,
    ),
    line(
      [
        [50, 'Premium'],
        [275, '1,200'],
        [393.9, 'A1'],
      ],
      686,
    ),
    line(
      [
        [50, 'Stamp duty'],
        [288.9, '35'],
        [387.5, 'B12C'],
      ],
      672,
    ),
    line(
      [
        [50, 'Total'],
        [275, '1,235'],
        [393.6, 'C3'],
      ],
      658,
    ),
  ].map((l): ClassifiedLine => ({ ...l, blockKind: 'paragraph' }));
  assert.deepEqual([...detectTableRowLines(lines)].sort(), [0, 1, 2, 3]);
  // The same rows with the amounts left where the old rule wanted them (left edges only) are not a table: no column matches.
  const ragged = lines.map((l, k): ClassifiedLine => ({ ...l, runs: l.runs.map((r, c) => (c === 1 ? { ...r, x: r.x + 9 * k } : r)) }));
  assert.equal(detectTableRowLines(ragged).size, 0);
});

test('a wrapped table with a right-aligned column assigns every cell to its header column', () => {
  const lines = [
    line(
      [
        [50, 'Step'],
        [150, 'What to do'],
        [375, 'Minutes'],
      ],
      700,
    ),
    line(
      [
        [50, 'Plan'],
        [150, 'Write the plan and'],
        [398.9, '30'],
      ],
      686,
    ),
    line([[150, 'share it.']], 674),
    line(
      [
        [50, 'Build'],
        [150, 'Implement the change.'],
        [393.3, '120'],
      ],
      660,
    ),
  ].map((l): ClassifiedLine => ({ ...l, blockKind: 'paragraph' }));
  const [t] = detectWrappedTables(lines, new Set(), 10);
  assert.ok(t !== undefined);
  assert.deepEqual(
    t.rows.map((r) => r.cells),
    [
      ['Plan', 'Write the plan and share it.', '30'],
      ['Build', 'Implement the change.', '120'],
    ],
  );
});

test('a scanned page: a short line set apart by blank space is a heading; "1 Step" before "2. Step" is numbered', () => {
  const recovered = { recovered: true as const };
  const ocr = (text: string, x: number, y: number, size = 8.8): Line => line([[x, text]], y, { size });
  const r = blocksOf(
    [
      // Body lines 13 pt apart; "Checklist" (normalised to body size) has 19 pt above it.
      ocr('We need to test the products with real people to keep us honest.', 7, 700),
      ocr('about what is important.', 7, 687),
      ocr('Checklist', 6, 668),
      ocr('1 Early in the project, spend time with users', 18, 653),
      ocr('2. Use a range of research methods', 18, 640),
      ocr('3. Test with people who use assistive technology', 18, 627),
    ],
    recovered,
    8.8,
  );
  assert.deepEqual(r.map(brief), [
    'p We need to test the products with real people to keep us honest. about what is important.',
    'h Checklist',
    '1@- Early in the project, spend time with users',
    '2@- Use a range of research methods',
    '3@- Test with people who use assistive technology',
  ]);
  // The same lines on a page with a text layer are not guessed at: no heading from spacing, no repaired number.
  const born = blocksOf([
    line([[7, 'Intro sentence here.']], 700),
    line([[6, 'Checklist']], 668),
    line([[18, '1 Early in the project']], 653),
    line([[18, '2. Use a range']], 640),
  ]);
  assert.equal(
    born.some((b) => b.kind === 'heading'),
    false,
  );
  assert.equal(
    born.some((b) => b.kind === 'list_item' && b.ordinal === 1),
    false,
  );
});

test('OCR lines: sizes near the page median become the body size, misread bullet glyphs become bullets', () => {
  const out = normalizeRecoveredLines([
    { text: 'Template', x: 10, y: 600, fontSizePt: 17.9 },
    { text: '@® [Tactfully list risks and blockers]', x: 26, y: 560, fontSizePt: 10.4 },
    { text: 'e Stakeholders know the status', x: 26, y: 540, fontSizePt: 12 },
    { text: 'Fill in the list.', x: 26, y: 520, fontSizePt: 11 },
    { text: 'every one of them', x: 26, y: 500, fontSizePt: 11 },
  ]);
  assert.deepEqual(
    out.map((l) => [l.text, l.fontSizePt]),
    [
      ['Template', 17.9],
      ['• [Tactfully list risks and blockers]', 11],
      ['• Stakeholders know the status', 11],
      ['Fill in the list.', 11],
      ['every one of them', 11],
    ],
  );
});
