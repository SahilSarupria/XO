import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionEscalationBindingResolver } from '../src/action-escalation-resolver.js';
import { StructuredComparisonBindingResolver } from '../src/structured-comparison-resolver.js';
import { resolveCapabilityBinding } from '../src/resolve-binding.js';
import type { SemanticCapabilityContract, SemanticCapabilityRule } from '../src/types.js';

/**
 * Action Capability Binding v1 — focused tests for
 * `ActionEscalationBindingResolver`. Fixtures are synthetic and
 * domain-varied on purpose (invoice reconciliation, vendor onboarding,
 * insurance claim) to demonstrate the resolver is evidence-driven, not
 * pattern-matched to any one profession's vocabulary.
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
    id: 'capability:reconcile-invoice',
    name: 'Reconcile the invoice balance',
    description: 'd',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'unknown',
    rules: [],
    actionKnowledgeRefs: [],
    confidence: 0.9,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:reconcile-invoice'],
    ...overrides,
  };
}

// --- A. Positive action capability -------------------------------------------------

test('A: a ruleless, action-grounded capability resolves to a human_in_the_loop binding', () => {
  const resolver = new ActionEscalationBindingResolver();
  const contract = makeContract({ actionKnowledgeRefs: [{ sourceNodeId: 'concept:reconcile-action', subtype: 'action' }] });
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved') return;
  assert.equal(outcome.binding.implementationClass, 'human_in_the_loop');
  assert.ok(outcome.binding.evaluate);
});

// --- B. process-backed capability -> same binding, if the model supports it -------

test('B: a ruleless, process-grounded capability also resolves to a human_in_the_loop binding', () => {
  const resolver = new ActionEscalationBindingResolver();
  const contract = makeContract({
    id: 'capability:onboard-vendor',
    name: 'Onboard Vendor',
    actionKnowledgeRefs: [{ sourceNodeId: 'concept:onboarding-process', subtype: 'process' }],
  });
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved') return;
  assert.equal(outcome.binding.implementationClass, 'human_in_the_loop');
});

// --- C. existing deterministic rule path is untouched ------------------------------

test('C: a contract with linked rules is left alone by this resolver (returns undefined), even if it also has action refs', () => {
  const resolver = new ActionEscalationBindingResolver();
  const contract = makeContract({ rules: [makeRule()], actionKnowledgeRefs: [{ sourceNodeId: 'concept:x', subtype: 'action' }], determinism: 'deterministic' });
  const outcome = resolver.resolve(contract);
  assert.equal(outcome, undefined);
});

test('C: resolveCapabilityBinding with both resolvers configured still resolves a rule-backed contract to deterministic_rule, never ambiguous', () => {
  const contract = makeContract({ rules: [makeRule()], determinism: 'deterministic' });
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') return;
  assert.equal(outcome.binding.implementationClass, 'deterministic_rule');
});

// --- D. ruleless, non-action capability remains unresolved --------------------------

test('D: a ruleless capability with no action/process linkage stays unresolved, not accidentally escalated', () => {
  const resolver = new ActionEscalationBindingResolver();
  const contract = makeContract({ actionKnowledgeRefs: [] });
  const outcome = resolver.resolve(contract);
  assert.equal(outcome, undefined);
});

test('D: resolveCapabilityBinding with both resolvers configured reports unresolved for a ruleless, non-action contract', () => {
  const contract = makeContract({ actionKnowledgeRefs: [] });
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(outcome.status, 'unresolved');
});

// --- Determinism does not gate human_in_the_loop -------------------------------------

test('a contract marked non_deterministic with action refs still resolves to human_in_the_loop (determinism gating is a deterministic_rule-only concern)', () => {
  const contract = makeContract({ determinism: 'non_deterministic', actionKnowledgeRefs: [{ sourceNodeId: 'concept:x', subtype: 'action' }] });
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') return;
  assert.equal(outcome.binding.implementationClass, 'human_in_the_loop');
});

// --- evaluate() safety boundary: never claims the action was performed --------------

test('evaluate() always succeeds and returns an escalation record, never a claim the action was performed', () => {
  const resolver = new ActionEscalationBindingResolver();
  const contract = makeContract({ actionKnowledgeRefs: [{ sourceNodeId: 'concept:reconcile-action', subtype: 'action' }] });
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved' || !outcome.binding.evaluate) return;
  const result = outcome.binding.evaluate({ invoiceId: 'INV-42' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const value = result.value as Record<string, unknown>;
  assert.equal(value['status'], 'escalation_required');
  assert.equal(value['capabilityId'], 'capability:reconcile-invoice');
  assert.deepEqual(value['input'], { invoiceId: 'INV-42' });
});

test('evaluate() is deterministic and pure: same contract + same input always yields deep-equal output', () => {
  const resolver = new ActionEscalationBindingResolver();
  const contract = makeContract({ actionKnowledgeRefs: [{ sourceNodeId: 'concept:reconcile-action', subtype: 'action' }] });
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved' || !outcome.binding.evaluate) return;
  const first = outcome.binding.evaluate({ invoiceId: 'INV-42' });
  const second = outcome.binding.evaluate({ invoiceId: 'INV-42' });
  assert.deepEqual(first, second);
});

// --- G. provenance: binding derivation carries the same action refs the contract has --

test('G: binding.derivation carries the exact actionKnowledgeRefs the contract was built with — provenance is not lost', () => {
  const resolver = new ActionEscalationBindingResolver();
  const refs = [
    { sourceNodeId: 'concept:reconcile-action', subtype: 'action' },
    { sourceNodeId: 'concept:payment-recording', subtype: 'action' },
  ];
  const contract = makeContract({ actionKnowledgeRefs: refs, sourceXoirNodeIds: ['capability:reconcile-invoice', ...refs.map((r) => r.sourceNodeId)] });
  const outcome = resolver.resolve(contract);
  assert.equal(outcome?.status, 'resolved');
  if (outcome?.status !== 'resolved') return;
  assert.deepEqual(outcome.binding.derivation, { actionKnowledgeRefs: refs });
});

// --- resolution determinism (brief §13.J) --------------------------------------------

test('J: resolving the same contract twice yields the same binding derivation', () => {
  const resolver = new ActionEscalationBindingResolver();
  const contract = makeContract({ actionKnowledgeRefs: [{ sourceNodeId: 'concept:reconcile-action', subtype: 'action' }] });
  const first = resolver.resolve(contract);
  const second = resolver.resolve(contract);
  assert.equal(first?.status, 'resolved');
  assert.equal(second?.status, 'resolved');
  if (first?.status !== 'resolved' || second?.status !== 'resolved') return;
  assert.deepEqual(first.binding.derivation, second.binding.derivation);
  assert.equal(first.binding.id, second.binding.id);
});

// --- forward-compat: a contract missing the field entirely (pre-milestone data) ------

test('a contract object missing actionKnowledgeRefs entirely (simulating pre-milestone embedded data) is treated as empty, not a crash', () => {
  const resolver = new ActionEscalationBindingResolver();
  const { actionKnowledgeRefs: _omit, ...rest } = makeContract();
  const legacyContract = rest as unknown as SemanticCapabilityContract;
  const outcome = resolver.resolve(legacyContract);
  assert.equal(outcome, undefined);
});
