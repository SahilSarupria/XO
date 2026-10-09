import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBodyFontSize, computeHeadingSizeLevels } from '../../src/document/font-stats.js';
import type { Line } from '../../src/document/line-grouper.js';

function line(text: string, fontSize: number, y = 700): Line {
  return { pageNumber: 1, y, minX: 72, maxFontSizePt: fontSize, text, runs: [] };
}

test('identifies the size with the most total characters as body size', () => {
  const lines = [line('Heading', 24), line('This is a long body paragraph with many characters in it.', 12), line('More body text continuing the paragraph further.', 12)];
  assert.equal(computeBodyFontSize(lines), 12);
});

test('ignores blank lines when computing body size', () => {
  const lines = [line('   ', 30), line('Body text here.', 12)];
  assert.equal(computeBodyFontSize(lines), 12);
});

test('returns a default when there are no lines at all', () => {
  assert.equal(computeBodyFontSize([]), 12);
});

test('computeHeadingSizeLevels returns sizes above body size, descending', () => {
  const lines = [line('Title', 24), line('Subtitle', 18), line('Body text', 12), line('More body', 12)];
  const levels = computeHeadingSizeLevels(lines, 12);
  assert.deepEqual(levels, [24, 18]);
});

test('computeHeadingSizeLevels excludes sizes at or below body size', () => {
  const lines = [line('Body', 12), line('Footnote', 8)];
  const levels = computeHeadingSizeLevels(lines, 12);
  assert.deepEqual(levels, []);
});
