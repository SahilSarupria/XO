import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences } from '../../src/capabilities/sentence-split.js';

test('splits multiple sentences on terminal punctuation', () => {
  const sentences = splitSentences('Send the notice. Review the response! Confirm receipt?');
  assert.deepEqual(
    sentences.map((s) => s.text),
    ['Send the notice.', 'Review the response!', 'Confirm receipt?'],
  );
});

test('handles a single sentence with no trailing punctuation', () => {
  const sentences = splitSentences('Send the notice');
  assert.deepEqual(sentences.map((s) => s.text), ['Send the notice']);
});

test('reports correct offsets', () => {
  const text = 'First sentence. Second sentence.';
  const sentences = splitSentences(text);
  assert.equal(text.slice(sentences[0]!.startOffset, sentences[0]!.endOffset), 'First sentence.');
  assert.equal(text.slice(sentences[1]!.startOffset, sentences[1]!.endOffset), 'Second sentence.');
});

test('ignores extra whitespace between sentences', () => {
  const sentences = splitSentences('First.   Second.');
  assert.equal(sentences.length, 2);
});

test('returns an empty array for empty text', () => {
  assert.deepEqual(splitSentences(''), []);
});

test('does not split on a period not followed by whitespace (e.g. inside an abbreviation-like token)', () => {
  const sentences = splitSentences('Contact e.g.info@example.com for help.');
  // A known, documented limitation — this is one "sentence" per our simple rule, since no period here is followed by whitespace until the very end.
  assert.equal(sentences.length, 1);
});

// --- Layer 1B (P0.9 Beta, see benchmark/CHANGELOG.md): "vs." must not create a false sentence boundary ---

test('"vs." followed by whitespace does not create a sentence boundary (the real Aastha case)', () => {
  const sentences = splitSentences('Reconcile invoice amounts vs. receipt amounts against Statement figures.');
  assert.deepEqual(sentences.map((s) => s.text), ['Reconcile invoice amounts vs. receipt amounts against Statement figures.']);
});

test('a short "A vs. B" style clause stays one sentence', () => {
  const sentences = splitSentences('Compare Plan A vs. Plan B for suitability.');
  assert.deepEqual(sentences.map((s) => s.text), ['Compare Plan A vs. Plan B for suitability.']);
});

test('"vs." mid-sentence does not swallow a genuine following sentence boundary', () => {
  const sentences = splitSentences('Compare A vs. B carefully. Then report the result.');
  assert.deepEqual(sentences.map((s) => s.text), ['Compare A vs. B carefully.', 'Then report the result.']);
});

test('the abbreviation check is case-insensitive ("Vs.", "VS.")', () => {
  assert.equal(splitSentences('Compare A Vs. B.').length, 1);
  assert.equal(splitSentences('Compare A VS. B.').length, 1);
});

test('a genuine sentence that happens to end in the word "vs" without a period is unaffected', () => {
  const sentences = splitSentences('It was Team A vs Team B. The crowd cheered.');
  assert.deepEqual(sentences.map((s) => s.text), ['It was Team A vs Team B.', 'The crowd cheered.']);
});

test('ordinary sentence boundaries are unaffected by the abbreviation check', () => {
  const sentences = splitSentences('The invoice was reconciled. The receipt was verified.');
  assert.deepEqual(sentences.map((s) => s.text), ['The invoice was reconciled.', 'The receipt was verified.']);
});
