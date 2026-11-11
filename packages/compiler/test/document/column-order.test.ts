import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { groupRunsIntoLines } from '../../src/document/line-grouper.js';
import { parseDocument } from '../../src/document/document-parser.js';
import { NodePdfLoader } from '../../src/pdf/pdf-loader.js';
import type { TextRun } from '../../src/pdf/content-stream.js';

const run = (text: string, x: number, y: number, size = 12): TextRun => ({ bytes: new Uint8Array(Buffer.from(text, 'latin1')), fontName: undefined, fontSizePt: size, x, y });
const PAGE = 595;
const LEFT = 50;
const RIGHT = 320;
const prose = (n: number, prefix: string) => `${prefix} ${n} words fill this narrow column`;
const texts = (lines: readonly { text: string }[]) => lines.map((l) => l.text);

/** `rows` rows of prose in two columns whose baselines coincide (the usual case) */
function twoColumnRuns(rows: number): TextRun[] {
  const runs: TextRun[] = [];
  for (let i = 0; i < rows; i += 1) {
    const y = 760 - i * 14;
    runs.push(run(prose(i, 'LEFT'), LEFT, y), run(prose(i, 'RIGHT'), RIGHT, y));
  }
  return runs;
}

test('two prose columns are read column by column (all of the left, then all of the right), not row-interleaved', () => {
  const lines = texts(groupRunsIntoLines(1, twoColumnRuns(10), undefined, PAGE));
  assert.deepEqual(lines, [...Array.from({ length: 10 }, (_, i) => prose(i, 'LEFT')), ...Array.from({ length: 10 }, (_, i) => prose(i, 'RIGHT'))]);
});

test('without a page width the legacy single-flow behaviour is unchanged (row-interleaved, merged lines)', () => {
  const lines = groupRunsIntoLines(1, twoColumnRuns(10), undefined);
  assert.equal(lines.length, 10);
  assert.match(lines[0]!.text, /LEFT 0.*RIGHT 0/);
});

test('a full-width title above the columns stays first; a centred page number below stays last', () => {
  const title = run('Combined Policy Handbook For All Departments And Their Staff Members', 50, 800, 18);
  const pageNo = run('Page 1', 285, 30);
  const lines = texts(groupRunsIntoLines(1, [...twoColumnRuns(8), title, pageNo], undefined, PAGE));
  assert.equal(lines[0], 'Combined Policy Handbook For All Departments And Their Staff Members');
  assert.equal(lines[lines.length - 1], 'Page 1');
  assert.equal(lines[1], prose(0, 'LEFT'));
  assert.equal(lines[8], prose(7, 'LEFT'));
  assert.equal(lines[9], prose(0, 'RIGHT'));
});

test('a table with a NARROW id column and a wide text column is NOT split into columns (row order preserved)', () => {
  const runs: TextRun[] = [];
  for (let i = 0; i < 10; i += 1) runs.push(run(`id-${i}`, 50, 760 - i * 14), run(prose(i, 'cell text that is long enough to be wide'), 150, 760 - i * 14));
  const lines = texts(groupRunsIntoLines(1, runs, undefined, PAGE));
  assert.equal(lines.length, 10);
  assert.match(lines[0]!, /^id-0 .*cell text/);
  assert.match(lines[9]!, /^id-9 .*cell text/);
});

test('too few lines per side is not evidence of columns', () => {
  const lines = groupRunsIntoLines(1, twoColumnRuns(3), undefined, PAGE);
  assert.equal(lines.length, 3);
});

test('a single wide column is untouched even when a page width is supplied', () => {
  const runs = Array.from({ length: 12 }, (_, i) => run(`A long single column line number ${i} that spans most of the page width without any gutter at all here`, 50, 760 - i * 14));
  const lines = texts(groupRunsIntoLines(1, runs, undefined, PAGE));
  assert.equal(lines.length, 12);
  assert.match(lines[0]!, /number 0/);
});

test('a real two-column PDF is extracted in reading order end to end', () => {
  const bytes = new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/two-column-prose.pdf', import.meta.url))));
  const loaded = new NodePdfLoader().load(bytes, 'two-column-prose.pdf');
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const flat = JSON.stringify(parseDocument(loaded.value).root).toLowerCase().replace(/\\n|\s+/g, ' ');
  const at = (needle: string): number => flat.indexOf(needle);
  // clause ids appear in document order across the column break (leave-1.1 ... contract-3.1 ... warranty-1.6 ... facility-1.4)
  const ids = ['leave-1.1', 'leave-2.2', 'sop-2.1', 'contract-2.2', 'contract-3.1', 'warranty-1.1', 'procurement-1.6', 'facility-1.4'];
  const positions = ids.map(at);
  assert.ok(positions.every((p) => p >= 0), JSON.stringify(positions));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('REGRESSION: a single column whose text is made of per-character/per-word runs is never mistaken for columns', () => {
  const runs: TextRun[] = [];
  for (let line = 0; line < 14; line += 1) {
    const y = 760 - line * 14;
    const words = `Validate the figures on line ${line} and record every invoice against the matching receipt`.split(' ');
    let x = 72;
    for (const w of words) {
      for (const ch of `${w} `) {
        runs.push(run(ch, x, y));
        x += 5.5;
      }
    }
  }
  const lines = groupRunsIntoLines(1, runs, undefined, PAGE);
  assert.equal(lines.length, 14);
  assert.match(lines[0]!.text, /^Validate the figures on line 0 and record/);
});

test('REGRESSION: label | description rows with wide columns and ragged right edge stay row-wise when the "gutter" is crossed by short labels', () => {
  const runs: TextRun[] = [];
  for (let i = 0; i < 10; i += 1) {
    const y = 760 - i * 14;
    runs.push(run(`Label number ${i} text`, 50, y), run(`Description for item ${i} that continues here`, 150, y));
  }
  const lines = groupRunsIntoLines(1, runs, undefined, PAGE);
  assert.equal(lines.length, 10);
  assert.match(lines[0]!.text, /Label number 0.*Description for item 0/);
});
