import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredCondition } from '../src/structured-expression-grammar.js';

/**
 * Regression: a categorical atom used to take the first recognised state word and silently drop everything after it,
 * so "<A> is missing or <B> is inactive" structured as just "<A> == missing" — a rule missing a real condition that
 * still looked fully understood. Wording below is deliberately domain-neutral (no industry vocabulary).
 */

test('OR of two state assertions keeps BOTH operands', () => {
  assert.deepEqual(parseStructuredCondition('the widget is missing or the gadget is inactive'), {
    type: 'or',
    operands: [
      { type: 'categorical', field: 'the widget', operator: '==', value: 'missing' },
      { type: 'categorical', field: 'the gadget', operator: '==', value: 'inactive' },
    ],
  });
});

test('AND of two state assertions keeps BOTH operands', () => {
  const c = parseStructuredCondition('the widget is active and the gadget is approved');
  assert.equal(c?.type, 'and');
  assert.equal(c?.type === 'and' ? c.operands.length : 0, 2);
});

test('a compound whose later operand cannot be structured is refused entirely, never reduced to its first operand', () => {
  assert.equal(parseStructuredCondition('the widget is present and the gadget is triggered by the schedule'), undefined);
  assert.equal(parseStructuredCondition('the widget is missing or the gadget behaves oddly'), undefined);
});

test('an exception or contrast tail is not silently dropped from a state assertion', () => {
  assert.equal(parseStructuredCondition('the widget is excluded unless the gadget is approved'), undefined);
  assert.equal(parseStructuredCondition('the widget is active but the gadget is not approved'), undefined); // "but" is not a supported connective: refuse, never truncate
});

test('single assertions and harmless qualifiers still structure (no over-refusal)', () => {
  assert.deepEqual(parseStructuredCondition('the widget is active'), { type: 'categorical', field: 'the widget', operator: '==', value: 'active' });
  assert.equal(parseStructuredCondition('the widget is excluded from scope of the arrangement')?.type, 'categorical');
  assert.equal(parseStructuredCondition('the widget is excluded (see the schedule and notes)')?.type, 'categorical');
});

test('"and"/"or" inside the FIELD name is still a single named category', () => {
  const c = parseStructuredCondition('Alpha and Beta is excluded');
  assert.deepEqual(c, { type: 'categorical', field: 'Alpha and Beta', operator: '==', value: 'excluded' });
});

test('"provided" as a participle is not a condition word, but "provided that" is', () => {
  assert.equal(parseStructuredCondition('any information provided in the form is incorrect')?.type, 'categorical');
  assert.equal(parseStructuredCondition('the widget is approved provided that the gadget is active'), undefined);
});

test('negated assertion keeps its polarity', () => {
  assert.deepEqual(parseStructuredCondition('the widget is not approved'), { type: 'categorical', field: 'the widget', operator: '!=', value: 'approved' });
});

test('a comma-separated list of assertions is never reduced to its first item(s)', () => {
  // One list item cannot be structured, so the whole condition must be refused — not turned into an AND of the rest.
  assert.equal(parseStructuredCondition('the widget is active, the gadget behaves oddly, and the part is approved'), undefined);
  assert.equal(parseStructuredCondition('the widget is active, the part is scheduled'), undefined);
});

test('a comma inside a number or parentheses is not a list separator', () => {
  assert.equal(parseStructuredCondition('the amount exceeds 10,000')?.type, 'comparison');
  assert.equal(parseStructuredCondition('the widget is excluded (see items a, b)')?.type, 'categorical');
});

test('a comma-separated NOUN list as the subject is a legitimate field, not a clause list', () => {
  const c = parseStructuredCondition('items kept outdoors, spare parts, and loose tools are excluded from scope of the arrangement');
  assert.deepEqual(c, { type: 'categorical', field: 'items kept outdoors, spare parts, and loose tools', operator: '==', value: 'excluded' });
});

// ── M2b: comma / Oxford-comma lists become AND/OR chains, only when fully and unambiguously parseable ─────────────────
const cat = (field: string, value: string, operator: '==' | '!=' = '==') => ({ type: 'categorical', field, operator, value });

test('Oxford-comma AND list structures with every operand', () => {
  assert.deepEqual(parseStructuredCondition('the widget is active, the gadget is approved, and the part is valid'), {
    type: 'and',
    operands: [cat('the widget', 'active'), cat('the gadget', 'approved'), cat('the part', 'valid')],
  });
});

test('Oxford-comma OR list structures with every operand', () => {
  assert.deepEqual(parseStructuredCondition('the widget is missing, the gadget is inactive, or the part is expired'), {
    type: 'or',
    operands: [cat('the widget', 'missing'), cat('the gadget', 'inactive'), cat('the part', 'expired')],
  });
});

test('a two-item list with a comma before the connective is a normal AND', () => {
  const c = parseStructuredCondition('the widget is active, and the gadget is approved');
  assert.equal(c?.type, 'and');
  assert.equal(c?.type === 'and' ? c.operands.length : 0, 2);
});

test('a comma inside a number does not split an operand', () => {
  const c = parseStructuredCondition('the amount exceeds 10,000, the widget is active, and the part is valid');
  assert.equal(c?.type, 'and');
  assert.equal(c?.type === 'and' ? c.operands.length : 0, 3);
});

test('a list with no terminating connective is ambiguous (AND or OR?) and is refused, never guessed', () => {
  assert.equal(parseStructuredCondition('the widget is active, the gadget is approved'), undefined);
});

test('a list mixing AND and OR is refused (no precedence guessing)', () => {
  assert.equal(parseStructuredCondition('the widget is active, the gadget is approved, or the part is valid and the unit is open'), undefined);
});

test('a list is refused as a whole when ANY item cannot be structured', () => {
  assert.equal(parseStructuredCondition('the widget is active, the gadget behaves oddly, and the part is valid'), undefined);
  assert.equal(parseStructuredCondition('the widget is active, the gadget is approved, and'), undefined);
});

test('generic status words are recognised as states (neutral vocabulary)', () => {
  for (const word of ['registered', 'unregistered', 'open', 'closed', 'scheduled', 'unavailable', 'suspended', 'verified', 'overdue', 'paid', 'unpaid', 'submitted']) {
    assert.deepEqual(parseStructuredCondition(`the item is ${word}`), cat('the item', word), word);
  }
});

test('a temporal qualifier after a state word is never silently dropped; a harmless agent qualifier still structures', () => {
  assert.equal(parseStructuredCondition('the request is submitted before the end of the review period'), undefined);
  assert.equal(parseStructuredCondition('the request is approved by the reviewer')?.type, 'categorical');
});

// ── Domain-profile lexicon hook: vocabulary extends per call, never globally ─────────────────────────────────────────
test('a domain profile lexicon adds state words for that call only; the core stays neutral', () => {
  const text = 'the sample is quarantined';
  assert.equal(parseStructuredCondition(text), undefined); // not in the neutral core
  assert.deepEqual(parseStructuredCondition(text, { categoricalStates: ['quarantined'] }), cat('the sample', 'quarantined'));
  assert.equal(parseStructuredCondition(text), undefined); // no leakage into a later call without the profile
});

test('a profile word participates in compound lists, and an unknown word still makes the whole list refuse', () => {
  const lex = { categoricalStates: ['quarantined'] };
  const c = parseStructuredCondition('the sample is quarantined, the batch is open, and the lot is verified', lex);
  assert.equal(c?.type, 'and');
  assert.equal(c?.type === 'and' ? c.operands.length : 0, 3);
  assert.equal(parseStructuredCondition('the sample is quarantined, the batch is mystifying, and the lot is verified', lex), undefined);
});

test('profile words are case-insensitive and a one-hop adverb still applies to a profile state', () => {
  assert.deepEqual(parseStructuredCondition('the sample is QUARANTINED', { categoricalStates: ['Quarantined'] }), cat('the sample', 'quarantined'));
  assert.deepEqual(parseStructuredCondition('the sample is currently quarantined', { categoricalStates: ['quarantined'] }), cat('the sample', 'quarantined'));
});
