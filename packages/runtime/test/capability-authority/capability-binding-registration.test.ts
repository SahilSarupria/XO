import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentHash } from '@xo/types';
import { computeContractContentHash } from '@xo/capability-contract';
import { PermissionManager, RuleBasedPolicy, Permissions, type PolicyRule } from '@xo/permissions';
import { StructuredComparisonBindingResolver, resolveCapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import { RuntimeCapabilityRegistry } from '../../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../../src/capability-authority/capability-binding-registration.js';

function managerWithRules(rules: readonly PolicyRule[]): PermissionManager {
  return new PermissionManager({ policy: new RuleBasedPolicy(rules) });
}

function claimEvaluationContract(overrides: Partial<SemanticCapabilityContract> = {}): SemanticCapabilityContract {
  return {
    id: 'capability:claim-evaluation',
    name: 'Evaluate Claim',
    description: 'Evaluates a submitted claim against extracted policy rules',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'deterministic',
    rules: [
      { sourceNodeId: 'decision:deny-large-claim', kind: 'decision_node', condition: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim', exceptionConditions: [], confidence: 0.9 },
    ],
    confidence: 0.9,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:deny-large-claim'],
    ...overrides,
  };
}

function resolvedBinding(contract: SemanticCapabilityContract) {
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver()]);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') throw new Error('unreachable');
  return outcome.binding;
}

test('a resolved deterministic_rule binding registers and executes end-to-end with no required permissions', async () => {
  const contract = claimEvaluationContract();
  const binding = resolvedBinding(contract);

  const registry = new RuntimeCapabilityRegistry();
  const registerResult = registerResolvedCapabilityBinding(registry, contract, binding);
  assert.equal(registerResult.ok, true);
  assert.equal(registry.has('capability:claim-evaluation'), true);

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) });
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.output, { matched: true, ruleSourceNodeId: 'decision:deny-large-claim', outcome: 'deny the claim' });
});

test('discovery does not imply execution authority: an unregistered binding is not reachable through the executor', async () => {
  const contract = claimEvaluationContract();
  resolvedBinding(contract); // resolved, but never registered

  const registry = new RuntimeCapabilityRegistry();
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) });
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_CAPABILITY_NOT_FOUND');
});

test('contract-declared required permissions are enforced: denied without the permission granted', async () => {
  const contract = claimEvaluationContract({ requiredPermissions: ['runtime.execute'] });
  const binding = resolvedBinding(contract);

  const registry = new RuntimeCapabilityRegistry();
  registerResolvedCapabilityBinding(registry, contract, binding);

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) }); // default-deny
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
});

test('contract-declared required permissions are enforced: succeeds once the permission is granted', async () => {
  const contract = claimEvaluationContract({ requiredPermissions: ['runtime.execute'] });
  const binding = resolvedBinding(contract);

  const registry = new RuntimeCapabilityRegistry();
  registerResolvedCapabilityBinding(registry, contract, binding);

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: managerWithRules([{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]),
  });
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, true);
});

test('an invalid contract-declared permission string is rejected at registration time', () => {
  const contract = claimEvaluationContract({ requiredPermissions: ['NOT A VALID PERMISSION ID'] });
  const binding = resolvedBinding(contract);
  const registry = new RuntimeCapabilityRegistry();
  const result = registerResolvedCapabilityBinding(registry, contract, binding);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_CAPABILITY_DECLARATION_INVALID');
  assert.equal(registry.has('capability:claim-evaluation'), false);
});

test('a non-deterministic_rule binding (e.g. runtime_registered) is rejected — only deterministic_rule is directly registerable', () => {
  const contract = claimEvaluationContract();
  const registry = new RuntimeCapabilityRegistry();
  const result = registerResolvedCapabilityBinding(registry, contract, {
    id: 'binding:external',
    contractId: contract.id,
    implementationClass: 'ai_provider',
    resolverName: 'not-implemented',
    description: 'A hypothetical future binding class',
    derivation: {},
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_CAPABILITY_DECLARATION_INVALID');
});

test('host-level additionalRequiredPermissions are enforced in addition to contract-declared ones', async () => {
  const contract = claimEvaluationContract();
  const binding = resolvedBinding(contract);
  const registry = new RuntimeCapabilityRegistry();
  registerResolvedCapabilityBinding(registry, contract, binding, { additionalRequiredPermissions: [{ permission: Permissions.runtime.execute }] });

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) });
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
});

// --- P0.9B, graph identity -----------------------------------------------

test('P0.9B: graphHash, when supplied at registration, is echoed all the way through to the executor result (live-graph path)', async () => {
  const contract = claimEvaluationContract();
  const binding = resolvedBinding(contract);

  const registry = new RuntimeCapabilityRegistry();
  const registerResult = registerResolvedCapabilityBinding(registry, contract, binding, { graphHash: ContentHash(`sha256:${'a'.repeat(64)}`) });
  assert.equal(registerResult.ok, true);

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) });
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.graphHash, `sha256:${'a'.repeat(64)}`);
});

test('P0.9B: graphHash is absent on the executor result when registration did not supply one (installed-package path — not a fabricated value)', async () => {
  const contract = claimEvaluationContract();
  const binding = resolvedBinding(contract);

  const registry = new RuntimeCapabilityRegistry();
  const registerResult = registerResolvedCapabilityBinding(registry, contract, binding, {});
  assert.equal(registerResult.ok, true);

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) });
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.graphHash, undefined);
});

// --- P0.9B, contract content hash ----------------------------------------

test('P0.9B: contractContentHash is recomputed from the contract and echoed to the executor result on BOTH information-boundary paths', async () => {
  const contract = claimEvaluationContract();
  const expected = computeContractContentHash(contract);

  for (const options of [{ graphHash: ContentHash(`sha256:${'c'.repeat(64)}`) }, {}]) {
    const registry = new RuntimeCapabilityRegistry();
    assert.equal(registerResolvedCapabilityBinding(registry, contract, resolvedBinding(contract), options).ok, true);
    const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) });
    const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.contractContentHash, expected);
  }
});

test('P0.9B: a stale/tampered stored contract.contentHash is never trusted — the registered hash is always recomputed', async () => {
  const contract = { ...claimEvaluationContract(), contentHash: `sha256:${'0'.repeat(64)}` };
  const registry = new RuntimeCapabilityRegistry();
  assert.equal(registerResolvedCapabilityBinding(registry, contract, resolvedBinding(contract), {}).ok, true);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: managerWithRules([]) });
  const result = await executor.execute({ capabilityId: 'capability:claim-evaluation', input: { claimed_loss_amount: 15000 } });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.contractContentHash, computeContractContentHash(claimEvaluationContract()));
});
