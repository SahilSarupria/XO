import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectCapitalizedRuns } from '../../src/knowledge/capitalized-run-detector.js';

test('detects a single capitalized word', () => {
  const runs = detectCapitalizedRuns('The parties agree that Acme shall comply.');
  assert.ok(runs.some((r) => r.text === 'Acme'));
});

test('detects a multi-word capitalized run', () => {
  const runs = detectCapitalizedRuns('This Agreement is between OpenAI Global LLC and the Client.');
  const match = runs.find((r) => r.text.startsWith('OpenAI'));
  assert.ok(match);
  assert.equal(match!.text, 'OpenAI Global LLC');
  assert.equal(match!.wordCount, 3);
});

test('absorbs a connector word inside a run', () => {
  const runs = detectCapitalizedRuns('Deposits are held by Bank of America for safekeeping.');
  const match = runs.find((r) => r.text.includes('Bank'));
  assert.equal(match!.text, 'Bank of America');
});

test('does not extend a run past its natural end via a trailing connector', () => {
  const runs = detectCapitalizedRuns('Acme of the region operates locally.');
  // "Acme" is capitalized, "of" is a connector, but "the" that follows is NOT capitalized, so the run must stop at "Acme" and not swallow "of the".
  const match = runs.find((r) => r.text.startsWith('Acme'));
  assert.equal(match!.text, 'Acme');
});

test('reports correct character offsets', () => {
  const text = 'Please contact Acme Corp for details.';
  const runs = detectCapitalizedRuns(text);
  const match = runs.find((r) => r.text.includes('Acme'))!;
  assert.equal(text.slice(match.startOffset, match.endOffset), match.text);
});

test('returns no runs for text with no capitalized words', () => {
  const runs = detectCapitalizedRuns('this sentence has no proper nouns at all.');
  assert.deepEqual(runs, []);
});

test('handles apostrophes and hyphens within a capitalized word', () => {
  const runs = detectCapitalizedRuns("O'Brien and Wal-Mart are both valid names.");
  assert.ok(runs.some((r) => r.text === "O'Brien"));
  assert.ok(runs.some((r) => r.text === 'Wal-Mart'));
});

// --- Layer 3: sentence-initial function-word false positives ---
// A closed-class function word (pronoun/determiner/conjunction/etc.) is
// capitalized only because it opens a sentence, never because it names a
// proper noun. As a lone (single-word) run it must not be reported; the
// same word inside a genuine multi-word run must still be absorbed
// normally (see `CONNECTOR_WORDS`), and the same word appearing
// mid-sentence (lowercase, so never a candidate run at all) is untouched.

test('does not report a lone sentence-initial pronoun as a capitalized run', () => {
  const runs = detectCapitalizedRuns('It does not represent any real rule.');
  assert.ok(!runs.some((r) => r.text === 'It'));
});

test('does not report a lone sentence-initial determiner as a capitalized run', () => {
  const runs = detectCapitalizedRuns('This is a synthetic document.');
  assert.ok(!runs.some((r) => r.text === 'This'));
});

test('does not report a lone sentence-initial subordinator as a capitalized run', () => {
  const runs = detectCapitalizedRuns('If the claim assessment amount exceeds 10000, then deny the claim.');
  assert.ok(!runs.some((r) => r.text === 'If'));
});

test('does not report other lone sentence-initial function words as capitalized runs', () => {
  for (const sentence of ['The Company reviews every claim.', 'Where the loss occurs, notify the insurer.', 'Upon receipt, process the claim.', 'Any claim exceeding the limit is escalated.']) {
    const runs = detectCapitalizedRuns(sentence);
    const leadWord = sentence.split(' ')[0]!;
    assert.ok(!runs.some((r) => r.text === leadWord), `expected no lone run for leading word "${leadWord}" in: ${sentence}`);
  }
});

test('still reports a genuine single-word proper noun that is not a function word', () => {
  const runs = detectCapitalizedRuns('Acme shall comply with the agreement.');
  assert.ok(runs.some((r) => r.text === 'Acme'));
});

test('still reports a multi-word run even when it starts with a function-word-shaped token', () => {
  // "This" alone would be filtered, but "This Agreement" is a genuine
  // two-word capitalized run and must not be suppressed by the
  // single-word-only function-word filter.
  const runs = detectCapitalizedRuns('This Agreement is between OpenAI Global LLC and the Client.');
  assert.ok(runs.some((r) => r.text === 'This Agreement'));
});

test('does not filter a function word that appears mid-sentence in lowercase', () => {
  // Lowercase "it"/"this" are never capitalized-word tokens in the first
  // place, so this is really testing that the fix only ever touches
  // capitalized single-word runs, never ordinary lowercase text.
  const runs = detectCapitalizedRuns('Acme says it will process this claim promptly.');
  assert.deepEqual(runs.map((r) => r.text), ['Acme']);
});
