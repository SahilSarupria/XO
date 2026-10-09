import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLines, type PageForClassification } from '../../src/document/block-classifier.js';
import type { Line } from '../../src/document/line-grouper.js';

function line(text: string, fontSize: number, y: number): Line {
  return { pageNumber: 1, y, minX: 72, maxFontSizePt: fontSize, text, runs: [] };
}

const mediaBox: readonly [number, number, number, number] = [0, 0, 612, 792];

test('classifies a larger-than-body line as a heading with the correct level', () => {
  const page: PageForClassification = { pageNumber: 1, mediaBox, lines: [line('Big Title', 24, 700), line('Body text', 12, 650)] };
  const result = classifyLines([page], 12, [24]);
  assert.equal(result[0]!.blockKind, 'heading');
  assert.equal(result[0]!.headingLevel, 1);
  assert.equal(result[1]!.blockKind, 'paragraph');
});

test('classifies a body-sized line near the bottom margin as a footnote when smaller than body', () => {
  const page: PageForClassification = { pageNumber: 1, mediaBox, lines: [line('A small footnote', 8, 40)] }; // y=40 is within the bottom 10% of a 792pt-tall page
  const result = classifyLines([page], 12, []);
  assert.equal(result[0]!.blockKind, 'footnote');
});

test('does not classify a small-font line away from the bottom margin as a footnote', () => {
  const page: PageForClassification = { pageNumber: 1, mediaBox, lines: [line('Small text mid-page', 8, 400)] };
  const result = classifyLines([page], 12, []);
  assert.equal(result[0]!.blockKind, 'paragraph');
});

test('classifies a line with a list marker as a list item', () => {
  const page: PageForClassification = { pageNumber: 1, mediaBox, lines: [line('1. First item', 12, 600)] };
  const result = classifyLines([page], 12, []);
  assert.equal(result[0]!.blockKind, 'list_item');
  assert.equal(result[0]!.listMarker, '1.');
  assert.equal(result[0]!.listText, 'First item');
});

test('skips blank lines entirely', () => {
  const page: PageForClassification = { pageNumber: 1, mediaBox, lines: [line('   ', 12, 600), line('Real text', 12, 580)] };
  const result = classifyLines([page], 12, []);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.text, 'Real text');
});

test('assigns an overflow level to a heading size not in the known levels list', () => {
  const page: PageForClassification = { pageNumber: 1, mediaBox, lines: [line('Unusual size heading', 30, 700)] };
  const result = classifyLines([page], 12, [24, 18]); // 30 isn't in the known levels
  assert.equal(result[0]!.blockKind, 'heading');
  assert.equal(result[0]!.headingLevel, 3); // levels.length + 1
});
