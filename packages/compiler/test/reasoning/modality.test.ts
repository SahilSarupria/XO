import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModality } from '../../src/reasoning/modality.js';

// Domain-neutral wording only: modality is a property of the language, never of the subject matter.
const cases: readonly [string, string, string][] = [
  ['the operator must log the event', 'obligation', 'positive'],
  ['the owner shall pay the fee', 'obligation', 'positive'],
  ['the request is required to include a reference', 'obligation', 'positive'],
  ['approval from the lead is required', 'obligation', 'positive'],
  ['approval from the lead is not required', 'obligation', 'negative'],
  ['the operator must not open the panel', 'prohibition', 'negative'],
  ['the owner shall not transfer the unit', 'prohibition', 'negative'],
  ['entry is not permitted', 'prohibition', 'negative'],
  ['the tool is prohibited', 'prohibition', 'negative'],
  ['items are never returned', 'prohibition', 'negative'],
  ['the supplier may suspend the service', 'permission', 'positive'],
  ['the order may be declined', 'permission', 'positive'],
  ['entry is permitted', 'permission', 'positive'],
  ['staff can request a replacement', 'permission', 'positive'],
  ['hotel rates should be reasonable', 'advisory', 'positive'],
  ['the team ought to review the log', 'advisory', 'positive'],
  ['the unit is excluded', 'declarative', 'positive'],
  ['the widget is not covered', 'declarative', 'negative'],
  ['the exclusion does not apply', 'declarative', 'negative'],
  ['notify the engineering lead', 'obligation', 'positive'],
  ['approve the request', 'obligation', 'positive'],
  ['the party must keep the data secret and must not disclose it', 'mixed', 'mixed'],
  ['', 'declarative', 'positive'],
];

for (const [text, modality, polarity] of cases) {
  test(`classifyModality: "${text}" -> ${modality}/${polarity}`, () => {
    assert.deepEqual(classifyModality(text), { modality, polarity });
  });
}

test('a prohibition always has negative polarity; a permission to decline is still a permission', () => {
  assert.equal(classifyModality('the claim may not proceed').modality, 'prohibition');
  assert.equal(classifyModality('the claim may be rejected').modality, 'permission');
});

test('an imperative that is itself permissive or advisory keeps that modality; a noun phrase is not read as an imperative', () => {
  assert.equal(classifyModality('record the entry if staff may').modality, 'permission');
  assert.equal(classifyModality('records are kept for audit').modality, 'declarative');
  assert.equal(classifyModality('the owner may approve the request').modality, 'permission');
});

test('classifyModality is case-insensitive and ignores surrounding whitespace', () => {
  assert.deepEqual(classifyModality('  The Operator MUST NOT leave  '), { modality: 'prohibition', polarity: 'negative' });
});
