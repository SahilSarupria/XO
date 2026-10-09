import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRunsIntoLines } from '../../src/document/line-grouper.js';
import type { TextRun } from '../../src/pdf/content-stream.js';

function run(text: string, x: number, y: number, fontSizePt = 8.5): TextRun {
  return { bytes: Buffer.from(text, 'latin1'), fontName: undefined, fontSizePt, x, y };
}

test('two runs on the same line with a real (table-column-sized) horizontal gap get a space inserted between them', () => {
  // "Policy Number" ends near x = 46.25 + 13*8.5*0.5 ≈ 101.5; the next
  // run starts at x = 127.13 — a ~25pt gap, several times a single
  // character width at this font size. Modeled directly on the real
  // burglary-policy.pdf fixture's "Policy NumberD279250237" defect.
  const runs = [run('Policy Number', 46.25, 777), run('D279250237', 127.13, 777)];
  const [line] = groupRunsIntoLines(1, runs);
  assert.equal(line!.text, 'Policy Number D279250237');
});

test('a wide (multi-column) horizontal gap also gets exactly one inserted space, not glued and not multiplied', () => {
  // Modeled on "Sr. NoAdd-On NameOpted(Yes / No)Limits (INR)": four
  // table column headers on one line, each separated by a real gap.
  const runs = [run('Sr. No', 48.5, 796.5), run('Add-On Name', 149.6, 796.5), run('Opted(Yes / No)', 250.7, 796.5), run('Limits (INR)', 351.8, 796.5)];
  const [line] = groupRunsIntoLines(1, runs);
  assert.equal(line!.text, 'Sr. No Add-On Name Opted(Yes / No) Limits (INR)');
});

test('runs that are genuinely adjacent (a single word split across runs for TJ kerning) are NOT separated by a space', () => {
  // A near-zero (here, slightly negative, as real kerning adjustments
  // often are) gap between two runs of the same word must stay joined.
  const runs = [run('Hel', 100, 500, 10), run('lo', 100 + 3 * 10 * 0.5 - 0.4, 500, 10)];
  const [line] = groupRunsIntoLines(1, runs);
  assert.equal(line!.text, 'Hello');
});

test('a run that already ends or begins with a space is not given a second, duplicate space', () => {
  const runs = [run('Click ', 50, 300, 10), run('here', 300, 300, 10)];
  const [line] = groupRunsIntoLines(1, runs);
  assert.equal(line!.text, 'Click here');
});

test('gap threshold scales with font size: the same absolute gap is a real separation at a small font size and a kerning artifact at a large one', () => {
  // At fontSizePt=6, threshold = max(1, 0.25*6) = 1.5pt; a 5pt gap should trigger a space.
  const small = groupRunsIntoLines(1, [run('a', 0, 100, 6), run('b', 5, 100, 6)]);
  assert.equal(small[0]!.text, 'a b');

  // At fontSizePt=40, threshold = 10pt; the same 5pt gap should NOT trigger a space (well within one glyph's width at that size).
  const large = groupRunsIntoLines(1, [run('a', 0, 100, 40), run('b', 5, 100, 40)]);
  assert.equal(large[0]!.text, 'ab');
});

test('multiple lines on a page are unaffected: each line is joined independently and line order (top to bottom) is unchanged', () => {
  const runs = [run('Second line', 46.25, 700), run('First line', 46.25, 800)];
  const lines = groupRunsIntoLines(1, runs);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.text, 'First line');
  assert.equal(lines[1]!.text, 'Second line');
});

test('two unrelated runs that coincidentally transform to the exact same page y (a real occurrence with generators that lay each line out via its own q/cm block on a shared line-height grid) are NOT merged into one interleaved line', () => {
  // Modeled directly on the real Aastha.pdf defect: "Identify \"Actual\"
  // brokerage..." (one q/cm/BT block, drawn as several forward-advancing
  // runs, several hundred operators earlier in the stream) and an
  // unrelated "CRM." fragment (a different block, from "Match CRM
  // records...") both transform to page y = 199.80, with "CRM." starting
  // at the exact x where "Identify" itself started. Naively bucketing by
  // y alone and then x-sorting produced "ICdReMnt.ify" — the "CRM."
  // glyphs spliced into the middle of "Identify" because both start at
  // the same x, and a pure x-sort has no way to tell them apart.
  const identifyStart = run('Identify "Actual" ', 116.25, 199.8, 8.25);
  const identifyContinuation = run('brokerage', 180.4, 199.8, 8.25); // forward-advancing: same block, later in the line
  const unrelatedCollision = run('CRM.', 116.25, 199.8, 8.25); // restarts at the line's own start x — a different block entirely
  const lines = groupRunsIntoLines(1, [identifyStart, identifyContinuation, unrelatedCollision]);
  assert.equal(lines.length, 2, 'the coincidental y-collision must produce two lines, not one interleaved line');
  const texts = lines.map((l) => l.text);
  assert.ok(texts.includes('Identify "Actual" brokerage'), 'the original run must survive intact, uninterleaved');
  assert.ok(texts.includes('CRM.'), 'the colliding unrelated run must land in its own line rather than splicing into the first');
});

test('same-y runs whose x-ranges genuinely do not overlap (e.g. distinct table columns) still merge into one line as before', () => {
  const left = run('Name', 50, 400, 10);
  const right = run('Amount', 200, 400, 10); // far right, no overlap with "Name"
  const [line] = groupRunsIntoLines(1, [left, right]);
  assert.equal(line!.text, 'Name Amount');
});
