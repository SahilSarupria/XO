import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsAnyPhrase, detectDefinedTerm, startsWithAnyPhrase, OBLIGATION_CUES, EXCEPTION_CUES } from '../../src/semantic/lexical-cues.js';

test('containsAnyPhrase finds a phrase at a word boundary', () => {
  assert.equal(containsAnyPhrase('The Contractor shall deliver the goods.', OBLIGATION_CUES), true);
});

test('containsAnyPhrase does not match a phrase embedded inside another word', () => {
  assert.equal(containsAnyPhrase('The shallow water receded.', ['shall']), false);
});

test('containsAnyPhrase is case-insensitive', () => {
  assert.equal(containsAnyPhrase('SHALL comply', OBLIGATION_CUES), true);
});

test('startsWithAnyPhrase matches only at the beginning of the (trimmed) text', () => {
  assert.equal(startsWithAnyPhrase('  Unless otherwise agreed, this applies.', EXCEPTION_CUES), true);
  assert.equal(startsWithAnyPhrase('This applies unless otherwise agreed.', ['unless']), false);
});

test('detectDefinedTerm finds a quoted term followed by "means"', () => {
  const term = detectDefinedTerm('"Confidential Information" means any non-public data.');
  assert.equal(term, 'Confidential Information');
});

test('detectDefinedTerm finds a quoted term followed by "shall mean"', () => {
  const term = detectDefinedTerm('"Effective Date" shall mean the date of signature.');
  assert.equal(term, 'Effective Date');
});

test('detectDefinedTerm returns undefined when a quote is not followed by a definition cue nearby', () => {
  const term = detectDefinedTerm('The document titled "Annual Report" was filed last year.');
  assert.equal(term, undefined);
});

test('detectDefinedTerm returns undefined when there is no quoted term at all', () => {
  assert.equal(detectDefinedTerm('This is a plain sentence.'), undefined);
});

test('detectDefinedTerm rejects an unreasonably long "quoted" span (likely two unrelated quotes)', () => {
  const longSpan = `"${'x'.repeat(100)}" means nothing useful`;
  assert.equal(detectDefinedTerm(longSpan), undefined);
});
