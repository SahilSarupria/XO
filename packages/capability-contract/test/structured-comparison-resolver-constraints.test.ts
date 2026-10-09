import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StructuredComparisonBindingResolver } from '../src/structured-comparison-resolver.js';
import type { SemanticCapabilityContract, SemanticCapabilityRule } from '../src/types.js';

// Regression coverage for the investigation into "Review Action" (see
// task write-up): a capability contract that links BOTH a bare
// `constraint` rule (no outcome, by design — see types.ts) and one or
// more executable `decision_node`/`heuristic` rules must still resolve
// to a working deterministic_rule binding. Before this fix,
// `compileRules` treated the constraint's missing outcome as a fatal
// error for the *entire* contract, so no capability with even one linked
// constraint could ever resolve, regardless of how many valid,
// executable rules sat alongside it.

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

function makeConstraint(overrides: Partial<SemanticCapabilityRule> = {}): SemanticCapabilityRule {
  return {
    sourceNodeId: 'constraint:1',
    kind: 'constraint',
    condition: 'Only claims with an active Policy may be considered for settlement',
    outcome: undefined,
    exceptionConditions: [],
    confidence: 0.9,
    ...overrides,
  };
}

function makeContract(overrides: Partial<SemanticCapabilityContract> = {}): SemanticCapabilityContract {
  return {
    id: 'capability:review-action',
    name: 'Review Action',
    description: 'd',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'deterministic',
    rules: [makeRule()],
    confidence: 0.9,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:review-action', 'decision:1'],
    ...overrides,
  };
}

test('a bare constraint rule (no outcome) alongside a valid heuristic/decision_node rule no longer blocks resolution', () => {
  const contract = makeContract({
    rules: [makeConstraint(), makeRule({ sourceNodeId: 'decision:amount', condition: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' })],
  });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved' || !outcome.binding.evaluate) throw new Error('expected resolved binding with evaluate');

  const matched = outcome.binding.evaluate({ claimed_loss_amount: 15000 });
  assert.equal(matched.ok, true);
  if (matched.ok) assert.deepEqual(matched.value, { matched: true, ruleSourceNodeId: 'decision:amount', outcome: 'deny the claim' });
});

test('the skipped bare constraint is recorded in derivation.skippedConstraints, never silently dropped', () => {
  const contract = makeContract({
    rules: [makeConstraint({ sourceNodeId: 'constraint:active-policy' }), makeRule()],
  });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved') return;
  const derivation = outcome.binding.derivation as { readonly skippedConstraints?: readonly { readonly sourceNodeId: string }[] };
  assert.ok(Array.isArray(derivation.skippedConstraints));
  assert.equal(derivation.skippedConstraints?.length, 1);
  assert.equal(derivation.skippedConstraints?.[0]?.sourceNodeId, 'constraint:active-policy');
});

test('multiple bare constraints do not block multiple valid heuristic rules from all compiling', () => {
  const contract = makeContract({
    rules: [
      makeConstraint({ sourceNodeId: 'constraint:1' }),
      makeConstraint({ sourceNodeId: 'constraint:2', condition: 'the police report must be present before final settlement' }),
      makeRule({ sourceNodeId: 'decision:small', condition: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' }),
    ],
  });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved') return;
  const derivation = outcome.binding.derivation as { readonly rules: readonly unknown[]; readonly skippedConstraints?: readonly unknown[] };
  assert.equal(derivation.rules.length, 1);
  assert.equal(derivation.skippedConstraints?.length, 2);
});

test('a contract whose ONLY linked rules are bare constraints remains unresolved (nothing executable), not resolved-with-empty-evaluator', () => {
  const contract = makeContract({ rules: [makeConstraint()] });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'unresolved');
  if (outcome?.status !== 'unresolved') return;
  assert.match(outcome.reason, /constraint/i);
});

test('a constraint kind rule that DOES carry a non-empty outcome is still treated as an executable rule (not skipped), same as any decision_node/heuristic', () => {
  const contract = makeContract({
    rules: [makeRule({ kind: 'constraint', sourceNodeId: 'constraint:with-outcome', condition: 'the claimed loss amount exceeds 10000', outcome: 'refer to underwriting' })],
  });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved' || !outcome.binding.evaluate) throw new Error('expected resolved binding');
  const result = outcome.binding.evaluate({ claimed_loss_amount: 15000 });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { matched: true, ruleSourceNodeId: 'constraint:with-outcome', outcome: 'refer to underwriting' });
});

test('an exception clause on a non-constraint rule still blocks the whole contract exactly as before (unchanged all-or-nothing discipline for decision_node/heuristic)', () => {
  const contract = makeContract({
    rules: [makeConstraint(), makeRule({ exceptionConditions: ['the claimant is a first responder'] })],
  });
  const resolver = new StructuredComparisonBindingResolver();
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'unresolved');
});