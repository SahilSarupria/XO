import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBlocks } from '../../src/document/block-builder.js';
import type { ClassifiedLine } from '../../src/document/block-classifier.js';

function paragraphLine(text: string, y: number, page = 1): ClassifiedLine {
  return { pageNumber: page, y, minX: 72, maxFontSizePt: 12, text, runs: [], blockKind: 'paragraph' };
}
function headingLine(text: string, level: number, y = 700): ClassifiedLine {
  return { pageNumber: 1, y, minX: 72, maxFontSizePt: 24, text, runs: [], blockKind: 'heading', headingLevel: level };
}
/** A line with real, positioned runs at the given x-coordinates, decodable via the default (no-resolver) latin1 path — see `text-runs-to-plain-text.ts`'s `decodeRunText` doc comment for why that's a correct, not just convenient, choice for plain-ASCII test fixtures. */
function runLine(cellsAtX: readonly (readonly [number, string])[], y: number, page = 1, blockKind: ClassifiedLine['blockKind'] = 'paragraph'): ClassifiedLine {
  const runs = cellsAtX.map(([x, text]) => ({ bytes: Buffer.from(text, 'latin1'), fontName: undefined, fontSizePt: 10, x, y }));
  const text = cellsAtX.map(([, t]) => t).join(' ');
  return { pageNumber: page, y, minX: cellsAtX[0]![0], maxFontSizePt: 10, text, runs, blockKind } as ClassifiedLine;
}

test('merges consecutive close paragraph lines into one paragraph block', () => {
  const lines = [paragraphLine('First line of a paragraph', 700), paragraphLine('continues here.', 686)];
  const blocks = buildBlocks(lines, 12);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'paragraph');
  if (blocks[0]!.kind === 'paragraph') assert.equal(blocks[0].text, 'First line of a paragraph continues here.');
});

test('starts a new paragraph block when the y-gap is large', () => {
  const lines = [paragraphLine('First paragraph.', 700), paragraphLine('Second paragraph, far below.', 600)];
  const blocks = buildBlocks(lines, 12);
  assert.equal(blocks.length, 2);
});

test('starts a new paragraph block across a page boundary even with a small y-gap', () => {
  const lines = [paragraphLine('End of page one.', 60, 1), paragraphLine('Start of page two.', 700, 2)];
  const blocks = buildBlocks(lines, 12);
  assert.equal(blocks.length, 2);
});

test('a heading interrupts and flushes an in-progress paragraph', () => {
  const lines = [paragraphLine('Some paragraph text', 700), headingLine('A Heading', 1, 686), paragraphLine('Text after the heading', 660)];
  const blocks = buildBlocks(lines, 12);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0]!.kind, 'paragraph');
  assert.equal(blocks[1]!.kind, 'heading');
  assert.equal(blocks[2]!.kind, 'paragraph');
});

test('provenance spans the merged paragraph\'s full y-range', () => {
  const lines = [paragraphLine('Line one', 700), paragraphLine('Line two', 686)];
  const blocks = buildBlocks(lines, 12);
  assert.deepEqual(blocks[0]!.provenance, { page: 1, yRange: [700, 686] });
});

test('two unrelated lines that coincidentally land at (near) the same page y are NOT merged into one paragraph', () => {
  // Modeled on the real Aastha.pdf defect: "Channel-wise revenue
  // generation (...)." (one bullet) and "validated reconciliation data."
  // (the wrapped tail of an unrelated, non-adjacent bullet several lines
  // later) both transform to the same page y. line-grouper.ts already
  // keeps these as two separate Line objects (they fail its x-backward
  // check); a real line of running text is always strictly below the one
  // before it, so a ~0 y-gap here can only mean "different coincidentally
  // colliding line," never a genuine wrapped continuation, and must not
  // be silently re-merged into one paragraph.
  const lines = [paragraphLine('Channel-wise revenue generation (Referral/Digital/Sales/Associate/POSP).', 480.58), paragraphLine('validated reconciliation data.', 480.58)];
  const blocks = buildBlocks(lines, 8.25);
  assert.equal(blocks.length, 2, 'a near-zero y-gap must start a new paragraph block, not merge');
  assert.equal(blocks[0]!.kind, 'paragraph');
  assert.equal(blocks[1]!.kind, 'paragraph');
  if (blocks[0]!.kind === 'paragraph') assert.equal(blocks[0].text, 'Channel-wise revenue generation (Referral/Digital/Sales/Associate/POSP).');
  if (blocks[1]!.kind === 'paragraph') assert.equal(blocks[1].text, 'validated reconciliation data.');
});

test('a genuinely tiny but real downward step (well above the collision-detection floor) still merges', () => {
  const lines = [paragraphLine('First line', 700), paragraphLine('continues, a modest real line-height gap', 695)];
  const blocks = buildBlocks(lines, 12);
  assert.equal(blocks.length, 1);
});

// --- P0.9A area C: table detection + quarantine ---

test('3+ consecutive lines with matching multi-column alignment become table_row blocks, not paragraphs', () => {
  const lines = [
    runLine([[49, 'Sr. No'], [150, 'Add-On Name'], [251, 'Opted'], [352, 'Limits (INR)']], 700),
    runLine([[49, '1.'], [150, 'Loss of Money'], [251, 'No'], [352, 'NA']], 686),
    runLine([[49, '2.'], [150, 'Clearing up Expenses'], [251, 'No'], [352, 'NA']], 672),
  ];
  const blocks = buildBlocks(lines, 10);
  assert.equal(blocks.length, 3);
  for (const b of blocks) assert.equal(b.kind, 'table_row');
  if (blocks[0]!.kind === 'table_row') assert.deepEqual(blocks[0].cells, ['Sr. No', 'Add-On Name', 'Opted', 'Limits (INR)']);
  if (blocks[1]!.kind === 'table_row') assert.deepEqual(blocks[1].cells, ['1.', 'Loss of Money', 'No', 'NA']);
});

test('only 2 consecutive aligned lines does NOT qualify as a table (below MIN_TABLE_ROWS) and stays ordinary paragraphs', () => {
  const lines = [runLine([[49, 'Net Premium (INR)'], [303, '202.50']], 700), runLine([[49, 'Total Add-On Cover Premium (INR)'], [303, '0.00']], 686)];
  const blocks = buildBlocks(lines, 10);
  assert.ok(blocks.every((b) => b.kind !== 'table_row'), 'two aligned lines alone must not be classified as a table');
});

test('a line with only 2 runs never qualifies as table start (below MIN_TABLE_COLUMNS), even repeated 3+ times', () => {
  // Models a real, non-tabular false-positive risk: a label/value clause line
  // ("Sum Insured Basis Opted    Market Value") has exactly 2 runs and should
  // never be mistaken for a table no matter how many times it repeats.
  const lines = [
    runLine([[49, 'Sum Insured Basis Opted'], [327, 'Market Value']], 700),
    runLine([[49, 'Excess Applicable'], [327, 'As per policy']], 686),
    runLine([[49, 'Claim Basis'], [327, 'Reinstatement']], 672),
  ];
  const blocks = buildBlocks(lines, 10);
  assert.ok(blocks.every((b) => b.kind !== 'table_row'), '2-run lines must never qualify, regardless of repetition');
});

test('a numbered clause with a trailing aligned value is not swept into a table by coincidental partial alignment', () => {
  // "1.1 Deductible means ... in the Schedule." (1 run) must not become part of
  // a table group even if it happens to sit near genuinely tabular lines.
  const clause = runLine([[49, '1.1 Deductible means the amount stated in the Schedule.']], 700, 1, 'list_item');
  const blocks = buildBlocks([clause], 10);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.kind, 'list_item');
});

test('an aligned group spanning a page boundary is NOT treated as one table (each page assessed independently)', () => {
  const lines = [
    runLine([[49, 'a'], [150, 'b'], [251, 'c']], 60, 1),
    runLine([[49, 'd'], [150, 'e'], [251, 'f']], 700, 2),
    runLine([[49, 'g'], [150, 'h'], [251, 'i']], 686, 2),
  ];
  const blocks = buildBlocks(lines, 10);
  assert.ok(blocks.every((b) => b.kind !== 'table_row'), 'a lone matching line on the prior page must not combine with 2 on the next page');
});

test('detected table_row blocks flush any in-progress paragraph buffer first', () => {
  const lines = [
    paragraphLine('Some intro prose before the table.', 700),
    runLine([[49, 'Sr. No'], [150, 'Add-On Name'], [251, 'Opted']], 686),
    runLine([[49, '1.'], [150, 'Loss of Money'], [251, 'No']], 672),
    runLine([[49, '2.'], [150, 'Clearing up'], [251, 'No']], 658),
  ];
  const blocks = buildBlocks(lines, 10);
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0]!.kind, 'paragraph');
  assert.equal(blocks[1]!.kind, 'table_row');
  assert.equal(blocks[2]!.kind, 'table_row');
  assert.equal(blocks[3]!.kind, 'table_row');
});
