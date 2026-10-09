import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySuspiciousToken, findSuspiciousTokens } from '../../src/document/text-legibility.js';

test('flags a lowercase word directly glued to a long digit run (either order) as digit_letter_mash', () => {
  assert.equal(classifySuspiciousToken('and8827461093'), 'digit_letter_mash');
  assert.equal(classifySuspiciousToken('9821invoice'), 'digit_letter_mash');
});

test('does NOT flag a real uppercase-led alphanumeric identifier (policy/UIN-style codes) as digit_letter_mash', () => {
  // These are drawn from the real burglary-policy.pdf fixture's own legitimate content.
  assert.equal(classifySuspiciousToken('D279250237'), undefined);
  assert.equal(classifySuspiciousToken('RA322234012'), undefined);
  assert.equal(classifySuspiciousToken('IRDAN158RP0019V02201920'), undefined);
});

test('flags two Title-Case words concatenated with no separator as title_case_word_fusion', () => {
  assert.equal(classifySuspiciousToken('NameOpted'), 'title_case_word_fusion');
  assert.equal(classifySuspiciousToken('PlanOpted'), 'title_case_word_fusion');
});

test('does NOT flag an ordinary single capitalized English word as suspicious (legitimate place names / nouns must survive)', () => {
  assert.equal(classifySuspiciousToken('Sion'), undefined);
  assert.equal(classifySuspiciousToken('Building'), undefined);
  assert.equal(classifySuspiciousToken('Region'), undefined);
});

test('does NOT flag lowerCamelCase (genuine code-identifier shape) as a fusion artifact', () => {
  assert.equal(classifySuspiciousToken('sendEmail'), undefined);
  assert.equal(classifySuspiciousToken('validateForm'), undefined);
});

test('flags a pathologically long single alphabetic token, but not a long alphanumeric one (e.g. a URL/id)', () => {
  assert.equal(classifySuspiciousToken('a'.repeat(30)), 'pathological_length');
  assert.equal(classifySuspiciousToken('a1'.repeat(20)), undefined);
});

test('strips surrounding punctuation before classifying, so trailing sentence punctuation does not hide (or fabricate) a finding', () => {
  assert.equal(classifySuspiciousToken('NameOpted,'), 'title_case_word_fusion');
  assert.equal(classifySuspiciousToken('"Sion"'), undefined);
});

test('findSuspiciousTokens scans whole text and reports every match in order, ignoring ordinary prose entirely', () => {
  const findings = findSuspiciousTokens('Partner Contact and8827461093 QUICKSURE BROKERS PRIVATE LIMITED');
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.token, 'and8827461093');
  assert.equal(findings[0]!.kind, 'digit_letter_mash');
});

test('findSuspiciousTokens returns an empty array for clean prose', () => {
  assert.deepEqual(findSuspiciousTokens('Contact the claims department within 30 days of any loss event.'), []);
});
