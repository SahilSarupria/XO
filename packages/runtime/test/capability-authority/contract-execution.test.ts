import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContentHash } from '@xo/types';
import { PermissionManager, RuleBasedPolicy, Permissions, type PolicyRule } from '@xo/permissions';
import { StructuredComparisonBindingResolver, ActionEscalationBindingResolver, computeContractContentHash, resolveCapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import { executeResolvedContract, resolveContractBinding } from '../../src/capability-authority/contract-execution.js';

/**
 * P0.9B Step 4 — the shared contract -> binding -> registration ->
 * executor assembly. Pins the behavior all three former hand-written
 * copies (apps/api execute + resume, apps/cli deterministic-router)
 * relied on, including both information-boundary paths.
 */

const manager = (rules: readonly PolicyRule[]) => new PermissionManager({ policy: new RuleBasedPolicy(rules) });

function contract(overrides: Partial<SemanticCapabilityContract> = {}): SemanticCapabilityContract {
  return {
    id: 'capability:claim-evaluation',
    name: 'Evaluate Claim',
    description: 'Evaluates a submitted claim against extracted policy rules',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'deterministic',
    rules: [{ sourceNodeId: 'decision:deny-large-claim', kind: 'decision_node', condition: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim', exceptionConditions: [], confidence: 0.9 }],
    confidence: 0.9,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:deny-large-claim'],
    ...overrides,
  };
}

function bound(c: SemanticCapabilityContract) {
  const outcome = resolveContractBinding(c);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') throw new Error('unreachable');
  return outcome.binding;
}

test('resolveContractBinding defaults to the standard pair: same outcome as resolving with it explicitly', () => {
  const c = contract();
  const viaHelper = resolveContractBinding(c);
  const viaExplicit = resolveCapabilityBinding(c, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(viaHelper.status, viaExplicit.status);
  if (viaHelper.status !== 'resolved' || viaExplicit.status !== 'resolved') return;
  assert.equal(viaHelper.binding.id, viaExplicit.binding.id);
});

test('resolveContractBinding never widens a caller-supplied resolver list (the installed-package path keeps its narrower set)', () => {
  const ruleless = contract({ rules: [] });
  // With only the structured-comparison resolver, a rule-less contract is not resolved by this list,
  // even though the standard pair has a second resolver that could have an opinion on other evidence.
  const narrow = resolveContractBinding(ruleless, [new StructuredComparisonBindingResolver()]);
  assert.notEqual(narrow.status, 'resolved');
});

test('executeResolvedContract: LIVE GRAPH path — executes and reports graphHash, contractContentHash, and the existing provenance fields', async () => {
  const c = contract();
  const graphHash = ContentHash(`sha256:${'e'.repeat(64)}`);
  const outcome = await executeResolvedContract(c, bound(c), { permissionManager: manager([]), input: { claimed_loss_amount: 15000 }, graphHash });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.value.output, { matched: true, ruleSourceNodeId: 'decision:deny-large-claim', outcome: 'deny the claim' });
  assert.equal(outcome.value.graphHash, graphHash);
  assert.equal(outcome.value.contractContentHash, computeContractContentHash(c));
  assert.equal(outcome.value.contractId, c.id);
  assert.equal(outcome.value.bindingId, bound(c).id);
  assert.deepEqual(outcome.value.sourceXoirNodeIds, c.sourceXoirNodeIds);
});

test('executeResolvedContract: INSTALLED PACKAGE path — no graphHash is invented, contractContentHash is still present', async () => {
  const c = contract();
  const outcome = await executeResolvedContract(c, bound(c), { permissionManager: manager([]), input: { claimed_loss_amount: 15000 } });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.graphHash, undefined);
  assert.equal(outcome.value.contractContentHash, computeContractContentHash(c));
});

test('executeResolvedContract: an invalid required-permission string fails at the "registration" stage', async () => {
  const c = contract({ requiredPermissions: ['NOT A VALID PERMISSION ID'] });
  const outcome = await executeResolvedContract(c, bound(c), { permissionManager: manager([]), input: {} });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'registration');
  assert.equal(outcome.error.code, 'XO_RUNTIME_CAPABILITY_DECLARATION_INVALID');
});

test('executeResolvedContract: the CALLER\'s permission policy decides — denied without the grant (stage "execution"), allowed with it', async () => {
  const c = contract({ requiredPermissions: ['runtime.execute'] });
  const denied = await executeResolvedContract(c, bound(c), { permissionManager: manager([]), input: { claimed_loss_amount: 15000 } });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.stage, 'execution');

  const allowed = await executeResolvedContract(c, bound(c), {
    permissionManager: manager([{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(allowed.ok, true);
});

test('executeResolvedContract: each call uses a fresh registry — nothing registered by an earlier call is reachable', async () => {
  const c = contract();
  const first = await executeResolvedContract(c, bound(c), { permissionManager: manager([]), input: { claimed_loss_amount: 15000 } });
  assert.equal(first.ok, true);
  // A different contract id executes independently; the first registration does not leak into it.
  const other = contract({ id: 'capability:other', sourceXoirNodeIds: ['capability:other'] });
  const second = await executeResolvedContract(other, bound(other), { permissionManager: manager([]), input: { claimed_loss_amount: 15000 } });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.value.contractId, 'capability:other');
});

// --- Step 6 end-to-end: a real execution result, projected against the live graph ---

import { XoirGraph, XoirGraphId, XoirNodeId, XoirEdgeId } from '@xo/xoir';
import { buildSemanticCapabilityContract, projectCapabilityProvenance, projectExecutionProvenance } from '@xo/capability-contract';

function liveGraph(): XoirGraph {
  const now = () => '2026-01-01T00:00:00.000Z';
  const g = XoirGraph.create(XoirGraphId('g-e2e'));
  g.createAndAddNode({ id: XoirNodeId('capability:claim-evaluation'), kind: 'capability', properties: { name: 'Evaluate Claim', description: 'd', determinism: 'deterministic' }, confidence: 0.9, now });
  g.createAndAddNode({ id: XoirNodeId('decision:deny-large-claim'), kind: 'decision_node', properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' }, confidence: 0.9, now });
  g.createAndAddEdge({ id: XoirEdgeId('r'), kind: 'REQUIRES', fromId: XoirNodeId('decision:deny-large-claim'), toId: XoirNodeId('capability:claim-evaluation'), now });
  return g;
}

test('Step 6 e2e (live graph path): the executed result agrees with the graph projection on graphHash, contractContentHash, bindingId, contractId', async () => {
  const g = liveGraph();
  const built = buildSemanticCapabilityContract(g, XoirNodeId('capability:claim-evaluation'));
  assert.ok(built.ok);
  const binding = bound(built.value);
  const outcome = await executeResolvedContract(built.value, binding, { permissionManager: manager([]), input: { claimed_loss_amount: 15000 }, graphHash: ContentHash(g.contentHash()) });
  assert.ok(outcome.ok);
  const cap = projectCapabilityProvenance(g, 'capability:claim-evaluation');
  assert.ok(cap.ok);
  const p = projectExecutionProvenance({ capabilityId: 'capability:claim-evaluation', ...outcome.value }, cap.value);
  assert.deepEqual(p.agreement, { graphHash: 'match', contractContentHash: 'match', bindingId: 'match', contractId: 'match' });
});

test('Step 6 e2e (installed-package path): contract/binding agree; graphHash is honestly unknown', async () => {
  const g = liveGraph();
  const built = buildSemanticCapabilityContract(g, XoirNodeId('capability:claim-evaluation'));
  assert.ok(built.ok);
  // The installed path only ever sees the embedded contract as JSON.
  const embedded = JSON.parse(JSON.stringify(built.value)) as typeof built.value;
  const outcome = await executeResolvedContract(embedded, bound(embedded), { permissionManager: manager([]), input: { claimed_loss_amount: 15000 } });
  assert.ok(outcome.ok);
  const cap = projectCapabilityProvenance(g, 'capability:claim-evaluation');
  assert.ok(cap.ok);
  const p = projectExecutionProvenance({ capabilityId: 'capability:claim-evaluation', ...outcome.value }, cap.value);
  assert.equal(p.agreement.graphHash, 'unknown');
  assert.equal(p.agreement.contractContentHash, 'match');
  assert.equal(p.agreement.bindingId, 'match');
});
