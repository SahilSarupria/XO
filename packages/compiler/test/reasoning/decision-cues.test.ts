import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDecisionCues } from '../../src/reasoning/decision-cues.js';
import { parseSentence } from '../../src/reasoning/rule-pattern-parser.js';

const DECISION_BEARING = [
  'The deductible for water damage is $500 per occurrence.',
  'Waiting period of 90 days applies before any benefit is payable.',
  'The insurer shall acknowledge each claim within 5 business days.',
  'Coverage is limited to a maximum of $250,000 per policy year.',
  'The policyholder is entitled to cancel within 14 days of purchase.',
  'The Company will pay the reasonable cost of repairs.',
  'Claims must be reported within 30 days of the loss event.',
];

const NOT_DECISION_BEARING = [
  'This claim form has 3 pages.',
  'Section 4 – Definitions',
  'Please read this document carefully.',
  'Page 3 of 12',
  '',
];

test('findDecisionCues flags obligations, limits, deadlines and entitlements', () => {
  for (const sentence of DECISION_BEARING) {
    assert.ok(findDecisionCues(sentence).length > 0, `expected cues for: ${sentence}`);
  }
});

test('findDecisionCues stays quiet on headings, fragments and plain description', () => {
  for (const sentence of NOT_DECISION_BEARING) {
    assert.deepEqual(findDecisionCues(sentence), [], `expected no cues for: ${JSON.stringify(sentence)}`);
  }
});

test('a single weak family alone (a number, or the word "claim") is not enough', () => {
  assert.deepEqual(findDecisionCues('The form is issued in 2 copies to each office.'), []);
  assert.deepEqual(findDecisionCues('A claim is an application made by an insured person.'), []);
});

test('cue output is sorted, de-duplicated and deterministic', () => {
  const cues = findDecisionCues('The insurer shall acknowledge each claim within 5 business days.');
  assert.deepEqual(cues, [...new Set(cues)].sort());
  assert.deepEqual(findDecisionCues('The insurer shall acknowledge each claim within 5 business days.'), cues);
});

test('error-analysis anchor: these decision-bearing sentences are NOT parsed by the rule patterns today (that is why they must be reported, not dropped)', () => {
  // If a future pattern starts parsing one of these, this test should be updated deliberately:
  // that is real recall progress, and the sentence then leaves the unclassified list.
  const unparsed = [
    'The deductible for water damage is $500 per occurrence.',
    'Waiting period of 90 days applies before any benefit is payable.',
    'The insurer shall acknowledge each claim within 5 business days.',
    'Coverage is limited to a maximum of $250,000 per policy year.',
    'The policyholder is entitled to cancel within 14 days of purchase.',
  ];
  for (const sentence of unparsed) {
    assert.equal(parseSentence(sentence).candidates.length, 0, `parser unexpectedly handles: ${sentence}`);
  }
});
