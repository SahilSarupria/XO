import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectListMarker } from '../../src/document/list-marker.js';

test('detects a bullet character marker', () => {
  const result = detectListMarker('• First item');
  assert.deepEqual(result, { marker: '•', remainder: 'First item', listKind: 'unordered' });
});

test('detects a dash bullet marker', () => {
  const result = detectListMarker('- Second item');
  assert.deepEqual(result, { marker: '-', remainder: 'Second item', listKind: 'unordered' });
});

test('detects a numbered marker with a period', () => {
  const result = detectListMarker('1. First numbered item');
  assert.deepEqual(result, { marker: '1.', remainder: 'First numbered item', listKind: 'ordered' });
});

test('detects a multi-digit numbered marker', () => {
  const result = detectListMarker('12. Twelfth item');
  assert.deepEqual(result, { marker: '12.', remainder: 'Twelfth item', listKind: 'ordered' });
});

test('detects a numbered marker with a closing paren', () => {
  const result = detectListMarker('3) Third item');
  assert.deepEqual(result, { marker: '3)', remainder: 'Third item', listKind: 'ordered' });
});

test('detects a lettered marker', () => {
  const result = detectListMarker('a) Sub-item');
  assert.deepEqual(result, { marker: 'a)', remainder: 'Sub-item', listKind: 'ordered' });
});

test('does not treat an ordinary sentence starting with a number as a list marker without following punctuation+space', () => {
  const result = detectListMarker('123 Main Street');
  assert.equal(result, undefined);
});

test('does not treat a decimal number as a list marker', () => {
  const result = detectListMarker('3.14 is pi');
  // "3." followed by "14..." with no space after the period is not a marker
  assert.equal(result, undefined);
});

test('returns undefined for text with no marker at all', () => {
  assert.equal(detectListMarker('This is a normal paragraph.'), undefined);
});

test('returns undefined for empty text', () => {
  assert.equal(detectListMarker(''), undefined);
});

// Regression for the Semantic Richness Investigation's Finding B: the real
// Aastha operations PDF uses U+25CB WHITE CIRCLE ('○') as its bullet glyph
// for procedural sub-steps. Before this glyph was added to BULLET_CHARS,
// every bulleted sub-step in a multi-step list merged into one paragraph
// block instead of forming a separate list_item per step.
test('detects the U+25CB WHITE CIRCLE bullet used by the real Aastha fixture', () => {
  const result = detectListMarker('○   Verify "Expected Brokerage" (from CRM) vs. "Actual Brokerage".');
  assert.deepEqual(result, { marker: '○', remainder: 'Verify "Expected Brokerage" (from CRM) vs. "Actual Brokerage".', listKind: 'unordered' });
});
