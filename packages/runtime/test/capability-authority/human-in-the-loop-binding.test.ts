import { test } from 'node:test';
import { testSubject } from '../authz-helpers.js';
import assert from 'node:assert/strict';
import { PermissionManager, RuleBasedPolicy, Permissions } from '@xo/permissions';
import {
  ActionEscalationBindingResolver,
  StructuredComparisonBindingResolver,
  resolveCapabilityBinding,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
import { RuntimeCapabilityRegistry } from '../../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../../src/capability-authority/capability-binding-registration.js';

/**
 * Action Capability Binding v1 — end-to-end proof that a
 * `human_in_the_loop` binding (produced by `ActionEscalationBindingResolver`
 * from a ruleless, action-grounded contract) reaches the exact same
 * runtime execution boundary — same registry, same executor, same
 * confidence gate (M1.4), same permission enforcement — as an existing
 * `deterministic_rule` binding does. Nothing about the executor or
 * registry changes; only the allow-list in
 * `capability-binding-registration.ts` was extended, which these tests
 * exercise directly rather than assume.
 */

function reconcileInvoiceContract(overrides: Partial<SemanticCapabilityContract> = {}): SemanticCapabilityContract {
  return {
    id: 'capability:reconcile-invoice-balance',
    name: 'Reconcile the invoice balance',
    description: 'Reconcile the outstanding invoice balance against recorded payments',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'unknown',
    rules: [],
    actionKnowledgeRefs: [
      { sourceNodeId: 'concept:reconcile-action-1', subtype: 'action' },
      { sourceNodeId: 'concept:reconcile-action-2', subtype: 'action' },
    ],
    confidence: 0.72,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:reconcile-invoice-balance', 'concept:reconcile-action-1', 'concept:reconcile-action-2'],
    ...overrides,
  };
}

function resolvedHumanInTheLoopBinding(contract: SemanticCapabilityContract) {
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') throw new Error('unreachable');
  assert.equal(outcome.binding.implementationClass, 'human_in_the_loop');
  return outcome.binding;
}

// --- End-to-end: real Action Capability Binding v1 path ------------------------------

test('a human_in_the_loop binding registers successfully (allow-list extended)', () => {
  const contract = reconcileInvoiceContract();
  const binding = resolvedHumanInTheLoopBinding(contract);

  const registry = new RuntimeCapabilityRegistry();
  const result = registerResolvedCapabilityBinding(registry, contract, binding);
  assert.equal(result.ok, true);
  assert.equal(registry.has(contract.id), true);
});

test('end-to-end: an action-grounded capability executes through RuntimeCapabilityExecutor and returns an escalation record, not a fabricated business result', async () => {
  const contract = reconcileInvoiceContract();
  const binding = resolvedHumanInTheLoopBinding(contract);

  const registry = new RuntimeCapabilityRegistry();
  registerResolvedCapabilityBinding(registry, contract, binding);

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const result = await executor.execute({ capabilityId: contract.id, input: { invoiceId: 'INV-42' } });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = result.value.output as Record<string, unknown>;
  assert.equal(output['status'], 'escalation_required');
  assert.equal(output['capabilityId'], contract.id);
  // Provenance: the escalation record itself carries the exact linked
  // XOIR node ids the contract was built from, so a caller can trace
  // runtime capability -> binding -> contract -> XOIR node without a
  // second provenance system.
  assert.deepEqual(output['actionKnowledgeRefs'], contract.actionKnowledgeRefs);
});

// --- M1.4 confidence gate applies identically to human_in_the_loop -------------------

test('M1.4: a human_in_the_loop capability below the configured minConfidence is denied before the handler runs', async () => {
  const contract = reconcileInvoiceContract();
  const binding = resolvedHumanInTheLoopBinding(contract);
  const registry = new RuntimeCapabilityRegistry();
  registerResolvedCapabilityBinding(registry, contract, binding);

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const result = await executor.execute({ capabilityId: contract.id, input: {}, confidenceScore: 0.5, minConfidence: 0.8 });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
});

test('M1.4: a human_in_the_loop capability at/above the configured minConfidence executes', async () => {
  const contract = reconcileInvoiceContract();
  const binding = resolvedHumanInTheLoopBinding(contract);
  const registry = new RuntimeCapabilityRegistry();
  registerResolvedCapabilityBinding(registry, contract, binding);

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const result = await executor.execute({ capabilityId: contract.id, input: {}, confidenceScore: 0.9, minConfidence: 0.8 });

  assert.equal(result.ok, true);
});

// --- Authorization gate applies identically to human_in_the_loop --------------------

test('authorization: a required permission is enforced for a human_in_the_loop binding just as it is for deterministic_rule', async () => {
  const contract = reconcileInvoiceContract({ requiredPermissions: ['runtime.execute'] });
  const binding = resolvedHumanInTheLoopBinding(contract);
  const registry = new RuntimeCapabilityRegistry();
  registerResolvedCapabilityBinding(registry, contract, binding);

  const denyingExecutor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const denied = await denyingExecutor.execute({ capabilityId: contract.id, input: {} });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, 'XO_RUNTIME_PERMISSION_DENIED');

  const allowingExecutor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({
      policy: new RuleBasedPolicy([{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]),
    }),
    subject: testSubject(),
  });
  const allowed = await allowingExecutor.execute({ capabilityId: contract.id, input: {} });
  assert.equal(allowed.ok, true);
});

// --- Discovered !== Bound !== Executable: an unregistered resolved binding is unreachable ---

test('safety boundary: a resolved-but-never-registered human_in_the_loop binding is not reachable through the executor (Bound != Executable)', async () => {
  const contract = reconcileInvoiceContract();
  resolvedHumanInTheLoopBinding(contract); // resolved, deliberately never registered

  const registry = new RuntimeCapabilityRegistry();
  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const result = await executor.execute({ capabilityId: contract.id, input: {} });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_CAPABILITY_NOT_FOUND');
});

// --- Discovered !== Trusted !== Contracted: a ruleless, non-action contract is never bound ---

test('safety boundary: a ruleless, non-action contract has no binding to register at all (Discovered != Bound)', () => {
  const contract = reconcileInvoiceContract({ actionKnowledgeRefs: [] });
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(outcome.status, 'unresolved');
});
