import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTextRuns, type TextRun } from '../../src/pdf/content-stream.js';

function textOf(run: TextRun): string {
  return Buffer.from(run.bytes).toString('latin1');
}

function ops(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'latin1'));
}

test('absolute Td positioning (no cm) is unchanged — identity CTM regression', () => {
  const runs = extractTextRuns(
    ops('BT /F1 12 Tf 72 700 Td (First line) Tj 0 -14 Td (Second line) Tj ET'),
  );
  assert.equal(runs.length, 2);
  assert.equal(textOf(runs[0]!), 'First line');
  assert.equal(runs[0]!.x, 72);
  assert.equal(runs[0]!.y, 700);
  assert.equal(textOf(runs[1]!), 'Second line');
  assert.equal(runs[1]!.x, 72);
  assert.equal(runs[1]!.y, 686);
  // No cm was ever applied, so font size must be untouched.
  assert.equal(runs[0]!.fontSizePt, 12);
  assert.equal(runs[1]!.fontSizePt, 12);
});

test('absolute Tm positioning (no cm) is unchanged — identity CTM regression', () => {
  const runs = extractTextRuns(ops('BT /F1 18 Tf 1 0 0 1 100 500 Tm (Heading) Tj ET'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.x, 100);
  assert.equal(runs[0]!.y, 500);
  assert.equal(runs[0]!.fontSizePt, 18);
});

test('a single q...cm...BT...ET...Q block translates text-space coordinates into page space', () => {
  const runs = extractTextRuns(ops('q 1 0 0 1 72 700 cm BT /F1 12 Tf 0 0 Td (Hello) Tj ET Q'));
  assert.equal(runs.length, 1);
  assert.equal(textOf(runs[0]!), 'Hello');
  assert.equal(runs[0]!.x, 72);
  assert.equal(runs[0]!.y, 700);
});

test('reproduces and fixes the Aastha defect pattern: multiple q/cm/BT/ET/Q line blocks that each reset to the same local Td offset must NOT collapse onto the same y', () => {
  const stream = [
    'q .75 0 0 .75 72 147.11 cm',
    'BT /F1 14.667 Tf 1 0 0 -1 0 0 Tm 0 -14.168 Td (Line one) Tj ET',
    'Q',
    'q .75 0 0 .75 72 128.66 cm',
    'BT /F1 14.667 Tf 1 0 0 -1 0 0 Tm 0 -14.168 Td (Line two) Tj ET',
    'Q',
    'q .75 0 0 .75 72 110.21 cm',
    'BT /F1 14.667 Tf 1 0 0 -1 0 0 Tm 0 -14.168 Td (Line three) Tj ET',
    'Q',
  ].join(' ');
  const runs = extractTextRuns(ops(stream));
  assert.equal(runs.length, 3);
  assert.equal(textOf(runs[0]!), 'Line one');
  assert.equal(textOf(runs[1]!), 'Line two');
  assert.equal(textOf(runs[2]!), 'Line three');

  const ys = runs.map((r) => r.y);
  assert.notEqual(ys[0], ys[1]);
  assert.notEqual(ys[1], ys[2]);
  assert.notEqual(ys[0], ys[2]);

  const scale = 0.75;
  const localY = -14.168;
  assert.ok(Math.abs(ys[0]! - (147.11 + localY * scale)) < 1e-6);
  assert.ok(Math.abs(ys[1]! - (128.66 + localY * scale)) < 1e-6);
  assert.ok(Math.abs(ys[2]! - (110.21 + localY * scale)) < 1e-6);
});

test('multiple transformed text blocks on one page retain distinct x AND y positions', () => {
  const stream = [
    'q 1 0 0 1 50 50 cm BT /F1 10 Tf 0 0 Td (Block A) Tj ET Q',
    'q 1 0 0 1 200 300 cm BT /F1 10 Tf 0 0 Td (Block B) Tj ET Q',
    'q 1 0 0 1 400 10 cm BT /F1 10 Tf 5 5 Td (Block C) Tj ET Q',
  ].join(' ');
  const runs = extractTextRuns(ops(stream));
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((r) => [r.x, r.y]),
    [
      [50, 50],
      [200, 300],
      [405, 15],
    ],
  );
});

test('q/Q correctly save and restore graphics state — a cm inside q...Q does not leak out afterward', () => {
  const stream = [
    'BT /F1 12 Tf 10 10 Td (Before) Tj ET',
    'q 1 0 0 1 500 500 cm BT /F1 12 Tf 0 0 Td (Inside) Tj ET Q',
    'BT /F1 12 Tf 20 20 Td (After) Tj ET',
  ].join(' ');
  const runs = extractTextRuns(ops(stream));
  assert.equal(runs.length, 3);
  assert.equal(textOf(runs[0]!), 'Before');
  assert.equal(runs[0]!.x, 10);
  assert.equal(runs[0]!.y, 10);
  assert.equal(textOf(runs[1]!), 'Inside');
  assert.equal(runs[1]!.x, 500);
  assert.equal(runs[1]!.y, 500);
  assert.equal(textOf(runs[2]!), 'After');
  assert.equal(runs[2]!.x, 20);
  assert.equal(runs[2]!.y, 20);
});

test('nested q/Q stack restores each level correctly', () => {
  const stream = [
    'q 1 0 0 1 10 0 cm',
    '  q 1 0 0 1 0 100 cm',
    '    BT /F1 12 Tf 0 0 Td (Nested) Tj ET',
    '  Q',
    '  BT /F1 12 Tf 0 0 Td (OuterOnly) Tj ET',
    'Q',
    'BT /F1 12 Tf 0 0 Td (Outside) Tj ET',
  ].join(' ');
  const runs = extractTextRuns(ops(stream));
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((r) => [textOf(r), r.x, r.y]),
    [
      ['Nested', 10, 100],
      ['OuterOnly', 10, 0],
      ['Outside', 0, 0],
    ],
  );
});

test('an unbalanced Q (no matching q) is tolerated and leaves the CTM unchanged', () => {
  const runs = extractTextRuns(ops('Q BT /F1 12 Tf 15 15 Td (Still fine) Tj ET'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.x, 15);
  assert.equal(runs[0]!.y, 15);
});

test('cm scale factor is folded into recorded fontSizePt so line-grouper gap heuristics stay consistent with transformed x/y', () => {
  const runs = extractTextRuns(ops('q .5 0 0 .5 0 0 cm BT /F1 20 Tf 0 0 Td (Scaled) Tj ET Q'));
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.fontSizePt, 10);
});

test('TJ arrays inside a cm-transformed block still merge kerned fragments and land at the transformed position', () => {
  const runs = extractTextRuns(ops('q 1 0 0 1 100 200 cm BT /F1 12 Tf 0 0 Td [(Hel) -20 (lo)] TJ ET Q'));
  assert.equal(runs.length, 2);
  assert.equal(textOf(runs[0]!), 'Hel');
  assert.equal(textOf(runs[1]!), 'lo');
  assert.equal(runs[0]!.x, 100);
  assert.equal(runs[0]!.y, 200);
  assert.equal(runs[1]!.x, 100);
  assert.equal(runs[1]!.y, 200);
});

test("' and \" operators still apply the leading-based newline before recording a run, inside a transformed block", () => {
  const runs = extractTextRuns(ops("q 1 0 0 1 0 0 cm BT /F1 12 Tf 12 TL 0 100 Td (One) Tj (Two) ' ET Q"));
  assert.equal(runs.length, 2);
  assert.equal(textOf(runs[0]!), 'One');
  assert.equal(runs[0]!.y, 100);
  assert.equal(textOf(runs[1]!), 'Two');
  assert.equal(runs[1]!.y, 88);
});
