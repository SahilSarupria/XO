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
    'The insurer shall acknowledge each claim within 5 business days.',
    'The handler shall register each claim within 1 working day of receipt, or as soon as practicable.',
    'Claim forms received after the closing date shall be treated as late submissions by the assessor.',
  ];
  for (const sentence of unparsed) {
    assert.equal(parseSentence(sentence).candidates.length, 0, `parser unexpectedly handles: ${sentence}`);
  }
});

import { tableRowStatement } from '../../src/reasoning/decision-cues.js';

test('WS1-03: a table row becomes header-bound facts when a decision-bearing column has a value', () => {
  const row = tableRowStatement(['Coverage', 'Limit', 'Excess'], ['Buildings', '1000000', '1000']);
  assert.ok(row);
  assert.equal(row!.text, 'Coverage: Buildings; Limit: 1000000; Excess: 1000');
  assert.ok(row!.cues.includes('limit'));
});

test('WS1-03: rows without a header, with too few cells, or with no decision-bearing column are not reported', () => {
  assert.equal(tableRowStatement(undefined, ['Buildings', '1000000']), undefined);
  assert.equal(tableRowStatement(['Name', 'Colour'], ['Roof', 'Red']), undefined);
  assert.equal(tableRowStatement(['Coverage', 'Limit'], ['Buildings', '']), undefined);
});

test('WS1 recall: quantified policy terms and liability exclusions are parsed (lowest priority, existing node types)', () => {
  const policy = [
    'A co-payment of 10% applies to every claim for insured persons above the age of 60.',
    'The Insured must pay a deductible of 500 per claim before the Insurer pays any amount.',
    'Room rent is limited to 1% of the sum insured per day.',
    'Maternity expenses will be covered after a waiting period of 9 months.',
    'Claims above 50000 require approval from the claims manager and a loss-adjuster assessment.',
  ];
  for (const sentence of policy) {
    const result = parseSentence(sentence);
    assert.ok(result.candidates.length > 0, `not parsed: ${sentence}`);
  }
  const quantified = parseSentence('A co-payment of 10% applies to every claim for insured persons above the age of 60.');
  assert.equal(quantified.candidates[0]!.nodeType, 'policy');
  assert.equal(quantified.candidates[0]!.matchedPattern, 'policy:quantified-term');
  const excl = parseSentence('The Insurer is not liable for damage occurring while the driver is under the influence of alcohol.');
  assert.equal(excl.candidates[0]!.nodeType, 'prohibition');
  assert.equal(excl.candidates[0]!.matchedPattern, 'prohibition:liability-exclusion');
});

test('WS1 recall: the new patterns need a number and never fire on plain description', () => {
  assert.equal(parseSentence('The policy limits are described in the schedule attached to this document.').candidates.length, 0);
  assert.equal(parseSentence('Is the excess of the policy shown here?').candidates.length, 0);
});
