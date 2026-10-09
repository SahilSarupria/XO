/**
 * Phase 2 deterministic synthetic semantic-expression benchmark fixture.
 *
 * Every case pairs a source text with a KNOWN ground-truth outcome —
 * either an exact expected `StructuredCondition`/`StructuredAction`, or
 * the literal string `'unresolved'` for a case this grammar must
 * deliberately refuse to structure. Both are first-class expected
 * outcomes: a `'unresolved'` case that the grammar structures anyway is
 * just as much a benchmark failure as a structurable case the grammar
 * misses — see `phase2-semantic-benchmark.test.ts` and
 * `phase2-semantic-benchmark.ts` for how this fixture is scored
 * (precision over cases the grammar DID structure, recall over cases
 * ground truth says SHOULD structure).
 *
 * Categories covered, each with at least one positive and one negative
 * case, per the Phase 2 brief's "SYNTHETIC PHASE 2 BENCHMARK" section:
 * >, <, >=, <=, equality, thresholds, ranges, AND, OR, exceptions,
 * supported temporal expressions, plus ambiguous/ out-of-vocabulary
 * negative cases the compiler must refuse to invent structure for.
 */

import type { StructuredAction, StructuredCondition } from '@xo/capability-contract';

export type FixtureExpected = StructuredCondition | 'unresolved';
export type FixtureActionExpected = StructuredAction | 'unresolved';

export interface ConditionFixtureCase {
  readonly id: string;
  readonly category: string;
  readonly text: string;
  readonly expected: FixtureExpected;
}

export interface ActionFixtureCase {
  readonly id: string;
  readonly category: string;
  readonly text: string;
  readonly expected: FixtureActionExpected;
}

export const CONDITION_FIXTURE: readonly ConditionFixtureCase[] = [
  // --- > ---
  { id: 'gt-01', category: '>', text: 'the claim assessment amount exceeds 10000', expected: { type: 'comparison', field: 'the claim assessment amount', operator: '>', value: 10000 } },
  { id: 'gt-02', category: '>', text: 'the claim amount is above 500', expected: { type: 'comparison', field: 'the claim amount', operator: '>', value: 500 } },
  { id: 'gt-03-neg', category: '>', text: 'as described above', expected: 'unresolved' }, // bare "above" with no numeric RHS

  // --- < ---
  { id: 'lt-01', category: '<', text: 'the claimed loss amount is under 500', expected: { type: 'comparison', field: 'the claimed loss amount', operator: '<', value: 500 } },
  { id: 'lt-02', category: '<', text: 'the premium is below 250', expected: { type: 'comparison', field: 'the premium', operator: '<', value: 250 } },
  { id: 'lt-03-neg', category: '<', text: 'excluded from scope of cover under the policy', expected: 'unresolved' }, // bare "under" with no numeric RHS — real-corpus shape

  // --- >= ---
  { id: 'gte-01', category: '>=', text: 'the deductible is at least 250', expected: { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 } },
  { id: 'gte-02', category: '>=', text: 'the deposit is a minimum of 100', expected: { type: 'comparison', field: 'the deposit', operator: '>=', value: 100 } },
  { id: 'gte-03-neg', category: '>=', text: 'at least try to respond quickly', expected: 'unresolved' }, // no numeric RHS at all

  // --- <= ---
  { id: 'lte-01', category: '<=', text: 'the premium is at most 500', expected: { type: 'comparison', field: 'the premium', operator: '<=', value: 500 } },
  { id: 'lte-02', category: '<=', text: 'the payout is a maximum of 1000', expected: { type: 'comparison', field: 'the payout', operator: '<=', value: 1000 } },
  { id: 'lte-03-neg', category: '<=', text: 'the maximum penalty for late filing was widely publicized', expected: 'unresolved' }, // "maximum" present but no comparison phrase / no numeric RHS shape

  // --- equality ---
  { id: 'eq-01', category: 'equality', text: 'the policy number equals 4471', expected: { type: 'comparison', field: 'the policy number', operator: '==', value: 4471 } },
  { id: 'eq-02', category: 'equality', text: 'the balance does not equal 0', expected: { type: 'comparison', field: 'the balance', operator: '!=', value: 0 } },
  { id: 'eq-03-neg', category: 'equality', text: 'the coverage exceeds expectations', expected: 'unresolved' }, // non-numeric RHS

  // --- thresholds / ranges ---
  { id: 'range-01', category: 'range', text: 'the claim amount is between 100 and 500', expected: { type: 'range', field: 'the claim amount', min: 100, max: 500 } },
  { id: 'range-02', category: 'range', text: 'the coverage amount is from 100 to 500', expected: { type: 'range', field: 'the coverage amount', min: 100, max: 500 } },
  { id: 'range-03-neg', category: 'range', text: 'the claim amount is between 500 and 100', expected: 'unresolved' }, // inverted bounds — refused, not silently swapped

  // --- categorical / boolean ---
  { id: 'cat-01', category: 'categorical', text: 'the claim status is approved', expected: { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' } },
  { id: 'cat-02', category: 'categorical', text: 'the policy is not active', expected: { type: 'categorical', field: 'the policy', operator: '!=', value: 'active' } },
  { id: 'cat-03', category: 'categorical', text: 'Terrorism cover is excluded', expected: { type: 'categorical', field: 'Terrorism cover', operator: '==', value: 'excluded' } },
  { id: 'cat-04-neg', category: 'categorical', text: 'the claim is suspicious', expected: 'unresolved' }, // out-of-vocabulary adjective
  { id: 'cat-05-neg', category: 'categorical', text: 'premium may vary depending on circumstances', expected: 'unresolved' },

  // --- AND ---
  {
    id: 'and-01',
    category: 'and',
    text: 'the deductible is at least 250 and the claim status is approved',
    expected: {
      type: 'and',
      operands: [
        { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 },
        { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' },
      ],
    },
  },
  { id: 'and-02', category: 'and', text: 'Theft and RSMD is Excluded', expected: { type: 'categorical', field: 'Theft and RSMD', operator: '==', value: 'excluded' } }, // "and" inside a genuine named category, not a conjunction
  { id: 'and-03-neg', category: 'and', text: 'the deductible is at least 250 and the claim was filed in good faith', expected: 'unresolved' }, // one operand unsupported — no partial conjunction

  // --- OR ---
  {
    id: 'or-01',
    category: 'or',
    text: 'the deductible is at least 250 or the claim status is approved',
    expected: {
      type: 'or',
      operands: [
        { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 },
        { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' },
      ],
    },
  },
  { id: 'or-02-neg', category: 'or', text: 'the claimant is a first responder or the claim is under 100', expected: 'unresolved' }, // one operand unsupported

  // --- exceptions (an UNLESS clause's own raw text run back through the same parser) ---
  { id: 'exc-01', category: 'exception', text: 'the claim status is approved', expected: { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' } },
  { id: 'exc-02-neg', category: 'exception', text: 'the customer has a premium subscription', expected: 'unresolved' },

  // --- temporal (structure only) ---
  { id: 'temp-01', category: 'temporal', text: 'the claim is filed within 30 days', expected: { type: 'temporal', relation: 'within', amount: 30, unit: 'days' } },
  { id: 'temp-02', category: 'temporal', text: 'a notice is sent after 7 days', expected: { type: 'temporal', relation: 'after', amount: 7, unit: 'days' } },
  { id: 'temp-03', category: 'temporal', text: 'the request is submitted before renewal', expected: { type: 'temporal', relation: 'before', anchor: 'renewal' } },
  { id: 'temp-04', category: 'temporal', text: 'coverage applies during the policy period', expected: { type: 'temporal', relation: 'during', anchor: 'policy period' } },
  { id: 'temp-05-neg', category: 'temporal', text: 'the request is submitted before the end of the extended grace period for renewal', expected: 'unresolved' }, // anchor too long, refused
  { id: 'temp-06-neg', category: 'temporal', text: 'existing protection, detection and alarm system to be maintained in well working condition throughout policy period', expected: 'unresolved' }, // "throughout" is deliberately not a recognized cue

  // --- ambiguous / mixed precedence (must refuse) ---
  { id: 'mixed-01-neg', category: 'ambiguous', text: 'the deductible is at least 250 and the claim status is approved or the claim status is excluded', expected: 'unresolved' },

  // --- real burglary-policy.pdf source text ---
  { id: 'real-01', category: 'real-source', text: 'any of the information provided is incorrect', expected: { type: 'categorical', field: 'any of the information provided', operator: '==', value: 'incorrect' } },
  { id: 'real-02-neg', category: 'real-source', text: 'there is 24 hours security in the premises', expected: 'unresolved' },
  {
    id: 'real-03',
    category: 'real-source',
    text: 'stocks/goods stored in open, money, monetary instruments and valuables of every kind and description are  excluded from scope of cover under the policy',
    expected: { type: 'categorical', field: 'stocks/goods stored in open, money, monetary instruments and valuables of every kind and description', operator: '==', value: 'excluded' },
  },
];

export const ACTION_FIXTURE: readonly ActionFixtureCase[] = [
  { id: 'act-01', category: 'action', text: 'deny the claim', expected: { type: 'action', action: 'deny', target: 'the claim' } },
  { id: 'act-02', category: 'action', text: 'apply a penalty fee', expected: { type: 'action', action: 'apply', target: 'a penalty fee' } },
  { id: 'act-03', category: 'action', text: 'escalate to a manager', expected: { type: 'action', action: 'escalate', target: 'to a manager' } },
  { id: 'act-04', category: 'action', text: 'escalate', expected: { type: 'action', action: 'escalate' } },
  { id: 'act-05-neg', category: 'action', text: 'finalize the assessment', expected: 'unresolved' }, // unrecognized leading verb
  { id: 'act-06-neg', category: 'action', text: 'Terrorism cover is excluded', expected: 'unresolved' }, // passive voice, not imperative
  { id: 'act-07-neg-real', category: 'action', text: 'valid', expected: 'unresolved' }, // real burglary-policy.pdf page-break truncation artifact
];
