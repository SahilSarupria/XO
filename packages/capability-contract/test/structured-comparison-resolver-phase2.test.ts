import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredComparisonBindingResolver } from '../src/structured-comparison-resolver.js';
import type { SemanticCapabilityContract, SemanticCapabilityRule } from '../src/types.js';
import type { StructuredCondition } from '../src/structured-expression-grammar.js';

function makeRule(overrides: Partial<SemanticCapabilityRule> = {}): SemanticCapabilityRule {
  return {
    sourceNodeId: 'decision:1',
    kind: 'decision_node',
    condition: 'the claimed loss amount exceeds 10000',
    outcome: 'deny the claim',
    exceptionConditions: [],
    confidence: 0.9,
    ...overrides,
  };
}

function makeContract(overrides: Partial<SemanticCapabilityContract> = {}): SemanticCapabilityContract {
  return {
    id: 'capability:claim-evaluation',
    name: 'Evaluate Claim',
    description: 'd',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'deterministic',
    rules: [makeRule()],
    confidence: 0.9,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:1'],
    ...overrides,
  };
}

function resolveAndEvaluate(contract: SemanticCapabilityContract, input: Readonly<Record<string, unknown>>) {
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved' || !outcome.binding.evaluate) throw new Error('expected resolved binding with evaluate');
  return outcome.binding.evaluate(input);
}

// --- AND lowering ----------------------------------------------------------

test('a rule with an AND structuredCondition (comparison + categorical) matches only when both sub-checks hold', () => {
  const structuredCondition: StructuredCondition = {
    type: 'and',
    operands: [
      { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 },
      { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' },
    ],
  };
  const contract = makeContract({ rules: [makeRule({ condition: 'ignored — structuredCondition takes precedence', structuredCondition })] });

  const bothTrue = resolveAndEvaluate(contract, { deductible: 300, claim_status: 'approved' });
  assert.equal(bothTrue.ok, true);
  if (bothTrue.ok) assert.deepEqual(bothTrue.value, { matched: true, ruleSourceNodeId: 'decision:1', outcome: 'deny the claim' });

  const onlyOneTrue = resolveAndEvaluate(contract, { deductible: 300, claim_status: 'pending' });
  assert.equal(onlyOneTrue.ok, true);
  if (onlyOneTrue.ok) assert.deepEqual(onlyOneTrue.value, { matched: false, outcome: undefined });
});

// --- OR lowering -------------------------------------------------------------

test('a rule with an OR structuredCondition matches when either sub-check holds', () => {
  const structuredCondition: StructuredCondition = {
    type: 'or',
    operands: [
      { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 },
      { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' },
    ],
  };
  const contract = makeContract({ rules: [makeRule({ structuredCondition })] });

  const onlyCategoricalTrue = resolveAndEvaluate(contract, { deductible: 10, claim_status: 'approved' });
  assert.equal(onlyCategoricalTrue.ok, true);
  if (onlyCategoricalTrue.ok) assert.deepEqual(onlyCategoricalTrue.value, { matched: true, ruleSourceNodeId: 'decision:1', outcome: 'deny the claim' });

  const neitherTrue = resolveAndEvaluate(contract, { deductible: 10, claim_status: 'pending' });
  assert.equal(neitherTrue.ok, true);
  if (neitherTrue.ok) assert.deepEqual(neitherTrue.value, { matched: false, outcome: undefined });
});

// --- Range lowering ----------------------------------------------------------

test('a rule with a range structuredCondition matches inclusively between min and max', () => {
  const structuredCondition: StructuredCondition = { type: 'range', field: 'the claim amount', min: 100, max: 500 };
  const contract = makeContract({ rules: [makeRule({ structuredCondition })] });

  for (const value of [100, 300, 500]) {
    const result = resolveAndEvaluate(contract, { claim_amount: value });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal((result.value as { matched: boolean }).matched, true, `expected ${value} to be within [100, 500]`);
  }
  const outside = resolveAndEvaluate(contract, { claim_amount: 600 });
  assert.equal(outside.ok, true);
  if (outside.ok) assert.equal((outside.value as { matched: boolean }).matched, false);
});

// --- Categorical lowering -----------------------------------------------------

test('a rule with a categorical structuredCondition requires a matching string input, case-insensitively', () => {
  const structuredCondition: StructuredCondition = { type: 'categorical', field: 'the claim status', operator: '==', value: 'approved' };
  const contract = makeContract({ rules: [makeRule({ structuredCondition })] });

  const matched = resolveAndEvaluate(contract, { claim_status: 'APPROVED' });
  assert.equal(matched.ok, true);
  if (matched.ok) assert.equal((matched.value as { matched: boolean }).matched, true);

  const nonString = resolveAndEvaluate(contract, { claim_status: 42 });
  assert.equal(nonString.ok, false);
});

test('a categorical "!=" structuredCondition inverts the match', () => {
  const structuredCondition: StructuredCondition = { type: 'categorical', field: 'the policy', operator: '!=', value: 'active' };
  const contract = makeContract({ rules: [makeRule({ structuredCondition })] });

  const inactive = resolveAndEvaluate(contract, { policy: 'cancelled' });
  assert.equal(inactive.ok, true);
  if (inactive.ok) assert.equal((inactive.value as { matched: boolean }).matched, true);

  const active = resolveAndEvaluate(contract, { policy: 'active' });
  assert.equal(active.ok, true);
  if (active.ok) assert.equal((active.value as { matched: boolean }).matched, false);
});

// --- Temporal: structured but explicitly NOT lowered/evaluated ---------------

test('a temporal structuredCondition cannot resolve to a deterministic binding on its own — no temporal logic engine exists to evaluate it', () => {
  const structuredCondition: StructuredCondition = { type: 'temporal', relation: 'within', amount: 30, unit: 'days' };
  const contract = makeContract({ rules: [makeRule({ condition: 'the claim was filed in good faith', structuredCondition })] });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  // Falls through to the legacy grammar on the raw `condition` text, which
  // also doesn't match here — so the whole contract is unresolved, exactly
  // as it would have been pre-Phase-2 for this same raw condition text.
  assert.equal(outcome?.status, 'unresolved');
});

test('a temporal structuredCondition falls back to the legacy comparison grammar on raw condition text when that text is itself a plain comparison', () => {
  const structuredCondition: StructuredCondition = { type: 'temporal', relation: 'before', anchor: 'renewal' };
  const contract = makeContract({ rules: [makeRule({ condition: 'the claimed loss amount exceeds 10000', structuredCondition })] });
  const result = resolveAndEvaluate(contract, { claimed_loss_amount: 15000 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { matched: true, ruleSourceNodeId: 'decision:1', outcome: 'deny the claim' });
});

// M1.3 — a duration-with-field temporal condition (`amount`+`unit`+
// `field` all present, `relation` `'within'`/`'after'`) DOES lower to a
// deterministic binding: a plain numeric comparison against a
// runtime-supplied day-count. Real policy §8.1/§8.2 shape.
test('M1.3: a "within N days" temporal condition with a field lowers to `<= N` and evaluates against a runtime-supplied day count', () => {
  const structuredCondition: StructuredCondition = { type: 'temporal', relation: 'within', amount: 7, unit: 'days', field: 'reported loss date' };
  const contract = makeContract({ rules: [makeRule({ condition: 'a claim notification received within 7 days of the reported loss date', outcome: 'the notification requirement is satisfied', structuredCondition })] });
  const within = resolveAndEvaluate(contract, { reported_loss_date: 5 });
  assert.equal(within.ok, true);
  if (within.ok) assert.equal((within.value as { matched: boolean }).matched, true);
  const outside = resolveAndEvaluate(contract, { reported_loss_date: 8 });
  assert.equal(outside.ok, true);
  if (outside.ok) assert.equal((outside.value as { matched: boolean }).matched, false);
});

test('M1.3: an "after N days" temporal condition with a field lowers to `> N`', () => {
  const structuredCondition: StructuredCondition = { type: 'temporal', relation: 'after', amount: 7, unit: 'days', field: 'reported loss date' };
  const contract = makeContract({ rules: [makeRule({ condition: 'a claim notification received more than 7 days after the reported loss date', outcome: 'the notification requirement is not satisfied', structuredCondition })] });
  const late = resolveAndEvaluate(contract, { reported_loss_date: 12 });
  assert.equal(late.ok, true);
  if (late.ok) assert.equal((late.value as { matched: boolean }).matched, true);
  const onTime = resolveAndEvaluate(contract, { reported_loss_date: 5 });
  assert.equal(onTime.ok, true);
  if (onTime.ok) assert.equal((onTime.value as { matched: boolean }).matched, false);
});

test('M1.3 negative: a duration temporal condition with amount+unit but no `field` still cannot resolve — no field key to compare against', () => {
  const structuredCondition: StructuredCondition = { type: 'temporal', relation: 'within', amount: 7, unit: 'days' };
  const contract = makeContract({ rules: [makeRule({ condition: 'the claim was filed in good faith', structuredCondition })] });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'unresolved');
});

test('M1.3 negative: anchor-based temporal (no amount/unit at all) still never lowers, even with M1.3\'s duration support present', () => {
  const structuredCondition: StructuredCondition = { type: 'temporal', relation: 'before', anchor: 'the date of loss' };
  const contract = makeContract({ rules: [makeRule({ condition: 'the policy has expired before the date of loss', outcome: 'refer the claim for coverage review', structuredCondition })] });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'unresolved');
});

// --- Backward compatibility: no structuredCondition at all --------------------

test('a rule with no structuredCondition resolves exactly as before, via the legacy single-comparison grammar', () => {
  const contract = makeContract({ rules: [makeRule()] }); // no structuredCondition field at all
  const result = resolveAndEvaluate(contract, { claimed_loss_amount: 15000 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { matched: true, ruleSourceNodeId: 'decision:1', outcome: 'deny the claim' });
});

// --- Declared inputs still gate structured fields, same as legacy fields -----

test('a structuredCondition field phrase not matching any declared input is unresolved, same discipline as the legacy grammar', () => {
  const structuredCondition: StructuredCondition = { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 };
  const contract = makeContract({ inputs: [{ name: 'policy number', description: 'the policy id' }], rules: [makeRule({ structuredCondition })] });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'unresolved');
});

// --- Exceptions still gate the whole contract regardless of structuredCondition ---

test('a non-empty exceptionConditions still makes the contract unresolved even when structuredCondition is present', () => {
  const structuredCondition: StructuredCondition = { type: 'comparison', field: 'the deductible', operator: '>=', value: 250 };
  const contract = makeContract({ rules: [makeRule({ structuredCondition, exceptionConditions: ['the claimant is a first responder'] })] });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'unresolved');
});

// --- Real rule shape: bounded adverb hop in parseCategoricalAtom feeding through to resolution ---

test('a heuristic whose condition contains a single "-ly" adverb before an already-recognized state (real vertical-test shape) compiles through the resolver', () => {
  const structuredCondition: StructuredCondition = { type: 'categorical', field: 'any information provided in the claim', operator: '==', value: 'incorrect' };
  const contract = makeContract({
    rules: [
      { sourceNodeId: 'kn_constraint_1', kind: 'constraint', condition: '6. Claims Procedure', exceptionConditions: [], confidence: 0.9 },
      makeRule({
        sourceNodeId: 'rn_4170a296bae8a16cbea1e1a180c1f8d7',
        kind: 'heuristic',
        condition: 'any information provided in the claim is materially incorrect',
        outcome: 'the claim may be rejected',
        structuredCondition,
      }),
    ],
  });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved' || !outcome.binding.evaluate) throw new Error('expected resolved binding with evaluate');
  const result = outcome.binding.evaluate({ any_information_provided_in_claim: 'incorrect' });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { matched: true, ruleSourceNodeId: 'rn_4170a296bae8a16cbea1e1a180c1f8d7', outcome: 'the claim may be rejected' });
});
