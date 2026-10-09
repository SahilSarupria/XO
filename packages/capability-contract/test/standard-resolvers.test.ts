import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STANDARD_BINDING_RESOLVERS } from '../src/standard-resolvers.js';
import { StructuredComparisonBindingResolver } from '../src/structured-comparison-resolver.js';
import { ActionEscalationBindingResolver } from '../src/action-escalation-resolver.js';
import { resolveCapabilityBinding } from '../src/resolve-binding.js';
import type { SemanticCapabilityContract, SemanticCapabilityRule } from '../src/types.js';

/**
 * P0.9B Step 2 — the one canonical resolver list. These tests pin that it
 * is exactly the pair (and order) every previous local declaration used,
 * and that resolution through it is identical to resolution through
 * freshly constructed instances of the same two classes.
 */

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

test('STANDARD_BINDING_RESOLVERS is exactly [StructuredComparison, ActionEscalation], in that order', () => {
  assert.equal(STANDARD_BINDING_RESOLVERS.length, 2);
  assert.ok(STANDARD_BINDING_RESOLVERS[0] instanceof StructuredComparisonBindingResolver);
  assert.ok(STANDARD_BINDING_RESOLVERS[1] instanceof ActionEscalationBindingResolver);
});

test('a rule-bearing contract resolves identically through the canonical list and through fresh instances', () => {
  const contract = makeContract();
  const viaCanonical = resolveCapabilityBinding(contract, STANDARD_BINDING_RESOLVERS);
  const viaFresh = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(viaCanonical.status, 'resolved');
  assert.equal(viaCanonical.status, viaFresh.status);
  if (viaCanonical.status !== 'resolved' || viaFresh.status !== 'resolved') return;
  assert.equal(viaCanonical.binding.implementationClass, 'deterministic_rule');
  assert.equal(viaCanonical.binding.id, viaFresh.binding.id);
});

test('a rule-less contract with no action evidence resolves identically through both (nothing resolves it either way)', () => {
  const contract = makeContract({ rules: [] });
  const viaCanonical = resolveCapabilityBinding(contract, STANDARD_BINDING_RESOLVERS);
  const viaFresh = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(viaCanonical.status, viaFresh.status);
});

test('the canonical list is safe to share: resolving repeatedly yields the same outcome (resolvers are stateless)', () => {
  const contract = makeContract();
  const a = resolveCapabilityBinding(contract, STANDARD_BINDING_RESOLVERS);
  const b = resolveCapabilityBinding(contract, STANDARD_BINDING_RESOLVERS);
  assert.equal(a.status, 'resolved');
  assert.equal(b.status, 'resolved');
  if (a.status !== 'resolved' || b.status !== 'resolved') return;
  // The binding carries an `evaluate` closure, so compare everything
  // observable rather than function identity.
  assert.equal(a.binding.id, b.binding.id);
  assert.deepEqual(a.binding.derivation, b.binding.derivation);
  const input = { claimed_loss_amount: 15000 };
  assert.deepEqual(a.binding.evaluate?.(input), b.binding.evaluate?.(input));
});
