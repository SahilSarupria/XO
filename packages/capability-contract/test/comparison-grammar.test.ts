import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseComparisonCondition, evaluateComparison } from '../src/comparison-grammar.js';

test('parses every accepted operator phrase', () => {
  const cases: readonly [string, string, number][] = [
    ['the claimed loss amount exceeds 10000', '>', 10000],
    ['the claimed loss amount is more than 10000', '>', 10000],
    ['the claimed loss amount is greater than 10000', '>', 10000],
    ['the claimed loss amount is less than 500', '<', 500],
    ['the claimed loss amount is under 500', '<', 500],
    ['the claimed loss amount is at least 1000', '>=', 1000],
    ['the claimed loss amount is at most 1000', '<=', 1000],
    ['the claimed loss amount equals 5000', '==', 5000],
    ['the claimed loss amount is equal to 5000', '==', 5000],
    ['the claimed loss amount is not equal to 5000', '!=', 5000],
    ['the claimed loss amount does not equal 5000', '!=', 5000],
  ];
  for (const [text, operator, value] of cases) {
    const parsed = parseComparisonCondition(text);
    assert.ok(parsed, `expected "${text}" to parse`);
    assert.equal(parsed!.operator, operator);
    assert.equal(parsed!.value, value);
    assert.equal(parsed!.fieldPhrase, 'the claimed loss amount');
  }
});

test('parses a dollar-prefixed, comma-grouped value', () => {
  const parsed = parseComparisonCondition('the claimed loss amount exceeds $10,000');
  assert.ok(parsed);
  assert.equal(parsed!.value, 10000);
});

test('parses a decimal value', () => {
  const parsed = parseComparisonCondition('the deductible is at least 250.50');
  assert.ok(parsed);
  assert.equal(parsed!.value, 250.5);
});

test('rejects a compound condition with two comparison phrases', () => {
  const parsed = parseComparisonCondition('the amount exceeds 100 and the age is less than 30');
  assert.equal(parsed, undefined);
});

test('rejects a non-numeric right-hand side', () => {
  const parsed = parseComparisonCondition('the claimant exceeds expectations');
  assert.equal(parsed, undefined);
});

test('rejects an empty field phrase', () => {
  const parsed = parseComparisonCondition('exceeds 100');
  assert.equal(parsed, undefined);
});

test('rejects text with no recognized comparison phrase', () => {
  const parsed = parseComparisonCondition('the claim was reviewed carefully');
  assert.equal(parsed, undefined);
});

test('does not match a comparison phrase inside a longer word (word-boundary matching)', () => {
  // "equals" must not match inside e.g. "sequels" — this text has no real comparison phrase.
  const parsed = parseComparisonCondition('the archive contains many sequels 5');
  assert.equal(parsed, undefined);
});

test('evaluateComparison implements all six operators correctly', () => {
  assert.equal(evaluateComparison('>', 11, 10), true);
  assert.equal(evaluateComparison('>', 9, 10), false);
  assert.equal(evaluateComparison('<', 9, 10), true);
  assert.equal(evaluateComparison('>=', 10, 10), true);
  assert.equal(evaluateComparison('<=', 10, 10), true);
  assert.equal(evaluateComparison('==', 10, 10), true);
  assert.equal(evaluateComparison('!=', 10, 11), true);
});
