import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredCondition, parseStructuredAction } from '../src/structured-expression-grammar.js';

// --- Numeric comparisons -----------------------------------------------

test('">" via "exceeds", with a currency code unit', () => {
  const result = parseStructuredCondition('the claim assessment amount exceeds INR 10,000');
  assert.deepEqual(result, { type: 'comparison', field: 'the claim assessment amount', operator: '>', value: 10000, unit: 'INR' });
});

test('">" via bare "above" only matches with a strict numeric right-hand side', () => {
  assert.deepEqual(parseStructuredCondition('the claim amount is above 500'), { type: 'comparison', field: 'the claim amount', operator: '>', value: 500 });
  // "above" appears in ordinary prose ("as described above") with no
  // numeric right-hand side — must not falsely fire.
  assert.equal(parseStructuredCondition('as described above'), undefined);
});

test('"<" via "is under" / bare "below", with a currency symbol unit', () => {
  assert.deepEqual(parseStructuredCondition('the claimed loss amount is under $500'), { type: 'comparison', field: 'the claimed loss amount', operator: '<', value: 500, unit: 'USD' });
  assert.deepEqual(parseStructuredCondition('the premium is below 250'), { type: 'comparison', field: 'the premium', operator: '<', value: 250 });
});

test('">=" via "at least" / "minimum of"', () => {
  assert.deepEqual(parseStructuredCondition('the deductible is at least 250'), { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 });
  assert.deepEqual(parseStructuredCondition('the deposit is a minimum of 100'), { type: 'comparison', field: 'the deposit', operator: '>=', value: 100 });
});

test('"<=" via "at most" / "maximum of"', () => {
  assert.deepEqual(parseStructuredCondition('the premium is at most 500'), { type: 'comparison', field: 'the premium', operator: '<=', value: 500 });
  assert.deepEqual(parseStructuredCondition('the payout is a maximum of 1000'), { type: 'comparison', field: 'the payout', operator: '<=', value: 1000 });
});

// M1.1 — real-policy shapes: "is less than or equal to" / "is greater
// than or equal to" (INR 10,000 / 100,000 threshold rules,
// XO_Commercial_Property_Test_Policy_Compatible.pdf §7).
test('M1.1: "<=" via "is less than or equal to", ">=" via "is greater than or equal to"', () => {
  assert.deepEqual(parseStructuredCondition('the claim amount is less than or equal to INR 10,000'), { type: 'comparison', field: 'the claim amount', operator: '<=', value: 10000, unit: 'INR' });
  assert.deepEqual(parseStructuredCondition('the claim amount is greater than or equal to INR 10,000'), { type: 'comparison', field: 'the claim amount', operator: '>=', value: 10000, unit: 'INR' });
});

test('"==" via "equals" and "!=" via "does not equal"', () => {
  assert.deepEqual(parseStructuredCondition('the policy number equals 4471'), { type: 'comparison', field: 'the policy number', operator: '==', value: 4471 });
  assert.deepEqual(parseStructuredCondition('the balance does not equal 0'), { type: 'comparison', field: 'the balance', operator: '!=', value: 0 });
});

test('negative: a non-numeric right-hand side never falls back to a guessed comparison', () => {
  assert.equal(parseStructuredCondition('the claim was filed in good faith'), undefined);
  assert.equal(parseStructuredCondition('the coverage exceeds expectations'), undefined);
});

// --- Threshold / range ---------------------------------------------------

test('"between X and Y" produces an inclusive range, trimming the leading copula from the field', () => {
  assert.deepEqual(parseStructuredCondition('the claim amount is between 100 and 500'), { type: 'range', field: 'the claim amount', min: 100, max: 500 });
});

test('"from X to Y" produces the same inclusive range shape, with a unit carried from either bound', () => {
  assert.deepEqual(parseStructuredCondition('the coverage amount is from INR 100 to 500'), { type: 'range', field: 'the coverage amount', min: 100, max: 500, unit: 'INR' });
});

test('negative: an inverted range (min > max) is rejected rather than silently swapped', () => {
  assert.equal(parseStructuredCondition('the claim amount is between 500 and 100'), undefined);
});

// --- Boolean / categorical conditions ------------------------------------

test('"<field> is <state>" / "is not <state>" from the closed state vocabulary', () => {
  assert.deepEqual(parseStructuredCondition('the claim status is approved'), { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' });
  assert.deepEqual(parseStructuredCondition('the policy is not active'), { type: 'categorical', field: 'the policy', operator: '!=', value: 'active' });
  assert.deepEqual(parseStructuredCondition('the request is not applicable'), { type: 'categorical', field: 'the request', operator: '!=', value: 'applicable' });
});

// M1.1 — "present"/"missing" categorical states, needed for real-policy
// document-prerequisite language ("all required documents are present",
// XO_Commercial_Property_Test_Policy_Compatible.pdf §7.1/§7.3).
test('M1.1: "present" / "missing" are recognized closed-vocabulary categorical states', () => {
  assert.deepEqual(parseStructuredCondition('all required documents are present'), { type: 'categorical', field: 'all required documents', operator: '==', value: 'present' });
  assert.deepEqual(parseStructuredCondition('the police report is missing'), { type: 'categorical', field: 'the police report', operator: '==', value: 'missing' });
});

// M1.2 — "denied" categorical state, needed for real-policy §9.4 ("When
// a claim is denied, the system must record the denial reason...").
// Evidence-driven: this exact word was the sole blocker on an
// already-clean, already-linked rule.
test('M1.2: "denied" is a recognized closed-vocabulary categorical state', () => {
  assert.deepEqual(parseStructuredCondition('a claim is denied'), { type: 'categorical', field: 'a claim', operator: '==', value: 'denied' });
});

test('real-source shape: a passive "<subject> is/are excluded[, ...]" sentence structures, trailing qualifier text is not fabricated into the value', () => {
  assert.deepEqual(parseStructuredCondition('Terrorism cover is excluded'), { type: 'categorical', field: 'Terrorism cover', operator: '==', value: 'excluded' });
  assert.deepEqual(parseStructuredCondition('Theft and RSMD is Excluded'), { type: 'categorical', field: 'Theft and RSMD', operator: '==', value: 'excluded' });
  assert.deepEqual(parseStructuredCondition('stocks stored in open are excluded from scope of cover under the policy'), {
    type: 'categorical',
    field: 'stocks stored in open',
    operator: '==',
    value: 'excluded',
  });
});

test('negative: an out-of-vocabulary adjective is never guessed at', () => {
  assert.equal(parseStructuredCondition('the claim is suspicious'), undefined);
  assert.equal(parseStructuredCondition('premium may vary depending on circumstances'), undefined);
});

// --- Single bounded adverbial modifier between copula and state word -----

test('a single "-ly" adverb between the copula and an already-recognized state still structures, identically to the unmodified form', () => {
  const withAdverb = parseStructuredCondition('the information is materially incorrect');
  const withoutAdverb = parseStructuredCondition('the information is incorrect');
  assert.deepEqual(withAdverb, { type: 'categorical', field: 'the information', operator: '==', value: 'incorrect' });
  assert.deepEqual(withAdverb, withoutAdverb);
});

test('the bounded adverb hop also applies to the negated copula form', () => {
  assert.deepEqual(parseStructuredCondition('the claim is not clearly covered'), { type: 'categorical', field: 'the claim', operator: '!=', value: 'covered' });
});

test('negative: an "-ly" word followed by an unrecognized state still returns undefined — the hop never widens the vocabulary', () => {
  assert.equal(parseStructuredCondition('the claim is materially suspicious'), undefined);
});

test('negative: a non-"-ly" word between the copula and a recognized state is not skipped — the hop is bounded to the adverb shape only', () => {
  assert.equal(parseStructuredCondition('the claim is definitely incorrect'.replace('definitely', 'somewhat')), undefined);
});

test('negative: more than one intervening modifier is not chased — only a single bounded hop is allowed', () => {
  assert.equal(parseStructuredCondition('the claim is materially clearly incorrect'), undefined);
});

test('real source shape: "any information provided in the claim is materially incorrect" structures as categorical, matching the unmodified burglary-policy.pdf form', () => {
  assert.deepEqual(parseStructuredCondition('any information provided in the claim is materially incorrect'), {
    type: 'categorical',
    field: 'any information provided in the claim',
    operator: '==',
    value: 'incorrect',
  });
});

// --- Conjunctions ---------------------------------------------------------

test('"A and B" builds a conjunction only when both operands independently parse', () => {
  assert.deepEqual(parseStructuredCondition('the deductible is at least 250 and the claim status is approved'), {
    type: 'and',
    operands: [
      { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 },
      { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' },
    ],
  });
});

test('a genuine named entity containing "and" is NOT torn apart into a false conjunction', () => {
  // Neither "Theft" nor "RSMD is Excluded" independently parses as a
  // condition atom, so this must resolve as one categorical atom whose
  // field legitimately contains "and" — never a 2-operand conjunction.
  const result = parseStructuredCondition('Theft and RSMD is Excluded');
  assert.equal(result?.type, 'categorical');
});

test('negative: "A and B" where one operand does not parse is left entirely unstructured (no partial conjunction)', () => {
  assert.equal(parseStructuredCondition('the deductible is at least 250 and the claim was filed in good faith'), undefined);
});

// --- Disjunctions ----------------------------------------------------------

test('"A or B" builds a disjunction only when both operands independently parse', () => {
  assert.deepEqual(parseStructuredCondition('the deductible is at least 250 or the claim status is approved'), {
    type: 'or',
    operands: [
      { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 },
      { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' },
    ],
  });
});

test('negative: "A or B" where one operand does not parse is left entirely unstructured', () => {
  assert.equal(parseStructuredCondition('the claimant is a first responder or the claim is under 100'), undefined);
});

test('negative: mixed "A and B or C" precedence is never guessed at', () => {
  assert.equal(parseStructuredCondition('the deductible is at least 250 and the claim status is approved or the claim status is excluded'), undefined);
});

// M1.1 regression — a comparison phrase's own internal "or" (as in "is
// less than or equal to") must never be mistaken for a real top-level
// disjunction connective, including when a genuine top-level "and" is
// also present in the same text (real-policy shape,
// XO_Commercial_Property_Test_Policy_Compatible.pdf §7.3: "claim amount
// <= INR 10,000 AND all required documents are present"). Before this
// fix, this text was incorrectly rejected as "mixed and/or precedence".
test('M1.1: an "or" embedded inside a fixed comparison phrase does not trigger the mixed and/or refusal', () => {
  assert.deepEqual(parseStructuredCondition('the claim amount is less than or equal to INR 10,000 and all required documents are present'), {
    type: 'and',
    operands: [
      { type: 'comparison', field: 'the claim amount', operator: '<=', value: 10000, unit: 'INR' },
      { type: 'categorical', field: 'all required documents', operator: '==', value: 'present' },
    ],
  });
  // Also confirm the phrase parses standalone (no "and" at all).
  assert.deepEqual(parseStructuredCondition('the claim amount is less than or equal to INR 10,000'), { type: 'comparison', field: 'the claim amount', operator: '<=', value: 10000, unit: 'INR' });
  // A genuine top-level "or" (not embedded in a comparison phrase) must
  // still be detected as a real disjunction — this fix must not blind
  // the OR-detector to actual "or" connectives.
  assert.deepEqual(parseStructuredCondition('the deductible is at least 250 or the claim status is approved'), {
    type: 'or',
    operands: [
      { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 },
      { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' },
    ],
  });
});

// --- Exceptions (structural note) ------------------------------------------
// Exception clauses are a separate ReasoningNode.exceptionConditions[]
// concern (see @xo/compiler's structured-semantics.ts and this package's
// StructuredExceptionCondition type) — the raw exception text is itself a
// candidate for parseStructuredCondition, exercised here directly.

test('an UNLESS clause\'s own text independently parses as a structured condition where the clause itself is a supported shape', () => {
  assert.deepEqual(parseStructuredCondition('the claimant is a first responder'), undefined); // out of vocabulary — correctly unresolved
  assert.deepEqual(parseStructuredCondition('the claim status is approved'), { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' });
});

// --- Temporal (structure only) ---------------------------------------------

test('"within N days" / "after N days" structure to a duration relation', () => {
  assert.deepEqual(parseStructuredCondition('the claim is filed within 30 days'), { type: 'temporal', relation: 'within', amount: 30, unit: 'days' });
  assert.deepEqual(parseStructuredCondition('a notice is sent after 7 days'), { type: 'temporal', relation: 'after', amount: 7, unit: 'days' });
});

test('"before X" / "during X" structure to an anchor relation for a short, non-numeric anchor phrase', () => {
  assert.deepEqual(parseStructuredCondition('the request is submitted before renewal'), { type: 'temporal', relation: 'before', anchor: 'renewal' });
  assert.deepEqual(parseStructuredCondition('coverage applies during the policy period'), { type: 'temporal', relation: 'during', anchor: 'policy period' });
});

test('negative: an overlong or numeric-laden anchor phrase is left unstructured rather than guessed at', () => {
  assert.equal(parseStructuredCondition('the request is submitted before the end of the extended grace period for renewal'), undefined);
});

test('negative: no temporal logic engine — this module never evaluates a duration, only structures it (no relative-to-now semantics exist here at all)', () => {
  const result = parseStructuredCondition('the claim is filed within 30 days');
  assert.equal(result?.type, 'temporal');
  assert.ok(!('evaluate' in (result as object)));
});

// M1.3 — real-policy §8.1/§8.2 duration shapes: "N calendar days" (an
// optional "calendar" filler between the number and the unit) and
// "more than N days" (an alternate surface form of the 'after'
// relation), plus capturing the trailing reference phrase as `field`.
test('M1.3: "N calendar days" — the "calendar" filler word does not block duration parsing', () => {
  assert.deepEqual(parseStructuredCondition('a notice is sent within 7 calendar days'), { type: 'temporal', relation: 'within', amount: 7, unit: 'days' });
});

test('M1.3: "more than N days" is recognized as an alternate surface form of the \'after\' relation', () => {
  assert.deepEqual(parseStructuredCondition('a notice is sent more than 7 days'), { type: 'temporal', relation: 'after', amount: 7, unit: 'days' });
});

test('M1.3: a trailing reference phrase after the duration is captured as `field`, sourced verbatim from the text', () => {
  assert.deepEqual(parseStructuredCondition('a claim notification received within 7 calendar days of the reported loss date'), {
    type: 'temporal',
    relation: 'within',
    amount: 7,
    unit: 'days',
    field: 'reported loss date',
  });
  assert.deepEqual(parseStructuredCondition('a claim notification received more than 7 calendar days after the reported loss date'), {
    type: 'temporal',
    relation: 'after',
    amount: 7,
    unit: 'days',
    field: 'reported loss date',
  });
});

test('M1.3 negative: an overlong trailing reference phrase is left uncaptured (no `field`) rather than guessed at', () => {
  const result = parseStructuredCondition('a notice is sent within 7 days of the date on which the underlying insured event was first reported to any representative of the Insurer');
  assert.equal(result?.type, 'temporal');
  assert.equal((result as { field?: string }).field, undefined);
});

// --- Real burglary-policy.pdf source text (Phase 2 "real source validation") ---

test('real source: "any of the information provided is incorrect" (burglary-policy.pdf rule condition) structures as categorical', () => {
  assert.deepEqual(parseStructuredCondition('any of the information provided is incorrect'), { type: 'categorical', field: 'any of the information provided', operator: '==', value: 'incorrect' });
});

test('real source: "there is 24 hours security in the premises" (burglary-policy.pdf) has no supported shape and is correctly left unstructured', () => {
  assert.equal(parseStructuredCondition('there is 24 hours security in the premises'), undefined);
});

test('real source: "...to be maintained in well working condition throughout policy period" (burglary-policy.pdf) is left unstructured — "throughout" is deliberately not a recognized temporal cue', () => {
  assert.equal(parseStructuredCondition('existing protection, detection and alarm system to be maintained in well working condition throughout policy period'), undefined);
});

// --- Action (verb + target) -------------------------------------------------

test('a recognized leading imperative verb structures to {action, target}', () => {
  assert.deepEqual(parseStructuredAction('deny the claim'), { type: 'action', action: 'deny', target: 'the claim' });
  assert.deepEqual(parseStructuredAction('apply a penalty fee'), { type: 'action', action: 'apply', target: 'a penalty fee' });
  assert.deepEqual(parseStructuredAction('escalate to a manager'), { type: 'action', action: 'escalate', target: 'to a manager' });
});

test('a verb with no target still structures, target omitted', () => {
  assert.deepEqual(parseStructuredAction('escalate'), { type: 'action', action: 'escalate' });
});

test('negative: an unrecognized leading verb is never guessed at', () => {
  assert.equal(parseStructuredAction('finalize the assessment'), undefined);
});

test('negative: a passive-voice, non-imperative fact has no action shape', () => {
  assert.equal(parseStructuredAction('Terrorism cover is excluded'), undefined);
});

test('real source: a truncated real-PDF extraction artifact ("valid") is correctly left unstructured rather than guessed at', () => {
  // The real burglary-policy.pdf's "The policy is not valid, if ..." sentence
  // is split across a page boundary by Phase 0/1 extraction, leaving only
  // "valid" as the action text for this rule node — see the Phase 2 final
  // report's "Deferred findings". This module must not invent a verb here.
  assert.equal(parseStructuredAction('valid'), undefined);
});
