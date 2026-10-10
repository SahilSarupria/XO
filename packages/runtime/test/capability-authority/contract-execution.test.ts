import { test } from 'node:test';
import { testSubject, declaredFrom } from '../authz-helpers.js';
import assert from 'node:assert/strict';
import { ContentHash } from '@xo/types';
import { PermissionManager, RuleBasedPolicy, Permissions, type PolicyRule } from '@xo/permissions';
import {
  StructuredComparisonBindingResolver,
  ActionEscalationBindingResolver,
  computeContractContentHash,
  resolveCapabilityBinding,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
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
    rules: [
      {
        sourceNodeId: 'decision:deny-large-claim',
        kind: 'decision_node',
        condition: 'the claimed loss amount exceeds 10000',
        outcome: 'deny the claim',
        exceptionConditions: [],
        confidence: 0.9,
      },
    ],
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
  const outcome = await executeResolvedContract(c, bound(c), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
    graphHash,
  });
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
  const outcome = await executeResolvedContract(c, bound(c), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.graphHash, undefined);
  assert.equal(outcome.value.contractContentHash, computeContractContentHash(c));
});

test('executeResolvedContract: an invalid required-permission string is denied at the "authorization" stage, before registration', async () => {
  const c = contract({ requiredPermissions: ['NOT A VALID PERMISSION ID'] });
  const outcome = await executeResolvedContract(c, bound(c), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([]),
    input: {},
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'authorization');
  assert.equal(outcome.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
});

test('executeResolvedContract: the CALLER\'s permission policy decides — denied without the grant (stage "execution"), allowed with it', async () => {
  const c = contract({ requiredPermissions: ['runtime.execute'] });
  const denied = await executeResolvedContract(c, bound(c), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(denied.ok, false);
  if (denied.ok) return;
  assert.equal(denied.stage, 'execution');

  const allowed = await executeResolvedContract(c, bound(c), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(allowed.ok, true);
});

test('executeResolvedContract: each call uses a fresh registry — nothing registered by an earlier call is reachable', async () => {
  const c = contract();
  const first = await executeResolvedContract(c, bound(c), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(first.ok, true);
  // A different contract id executes independently; the first registration does not leak into it.
  const other = contract({ id: 'capability:other', sourceXoirNodeIds: ['capability:other'] });
  const second = await executeResolvedContract(other, bound(other), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(other),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
  });
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
  g.createAndAddNode({
    id: XoirNodeId('capability:claim-evaluation'),
    kind: 'capability',
    properties: { name: 'Evaluate Claim', description: 'd', determinism: 'deterministic' },
    confidence: 0.9,
    now,
  });
  g.createAndAddNode({
    id: XoirNodeId('decision:deny-large-claim'),
    kind: 'decision_node',
    properties: { question: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim' },
    confidence: 0.9,
    now,
  });
  g.createAndAddEdge({
    id: XoirEdgeId('r'),
    kind: 'REQUIRES',
    fromId: XoirNodeId('decision:deny-large-claim'),
    toId: XoirNodeId('capability:claim-evaluation'),
    now,
  });
  return g;
}

test('Step 6 e2e (live graph path): the executed result agrees with the graph projection on graphHash, contractContentHash, bindingId, contractId', async () => {
  const g = liveGraph();
  const built = buildSemanticCapabilityContract(g, XoirNodeId('capability:claim-evaluation'));
  assert.ok(built.ok);
  const binding = bound(built.value);
  const outcome = await executeResolvedContract(built.value, binding, {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(built.value),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
    graphHash: ContentHash(g.contentHash()),
  });
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
  const outcome = await executeResolvedContract(embedded, bound(embedded), {
    subject: testSubject(),
    permissionDeclaration: declaredFrom(embedded),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.ok(outcome.ok);
  const cap = projectCapabilityProvenance(g, 'capability:claim-evaluation');
  assert.ok(cap.ok);
  const p = projectExecutionProvenance({ capabilityId: 'capability:claim-evaluation', ...outcome.value }, cap.value);
  assert.equal(p.agreement.graphHash, 'unknown');
  assert.equal(p.agreement.contractContentHash, 'match');
  assert.equal(p.agreement.bindingId, 'match');
});

// ── P1.0 M2: authorization denials happen before any registration/handler side effect ──
import { establishAuthenticatedPrincipal, PERMISSION_FREE, resolveDeclaredPermissionIds } from '@xo/permissions';

function countingBinding(c: ReturnType<typeof contract>) {
  const b = bound(c);
  let calls = 0;
  const original = b.evaluate!;
  return {
    binding: {
      ...b,
      evaluate: (i: unknown) => {
        calls += 1;
        return original(i as never);
      },
    } as typeof b,
    calls: () => calls,
  };
}
const alice = () => {
  const r = establishAuthenticatedPrincipal({ kind: 'human', id: 'alice' });
  if (!r.ok) throw r.error;
  return r.value;
};

test('M2: unresolved (missing) permission declaration is denied and the handler never runs', async () => {
  const c = contract();
  const cb = countingBinding(c);
  const outcome = await executeResolvedContract(c, cb.binding, {
    subject: alice(),
    permissionDeclaration: resolveDeclaredPermissionIds(undefined, 'node'),
    permissionManager: manager([]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'authorization');
  assert.equal(cb.calls(), 0);
});

test('M2: declaration that conflicts with the contract copy is denied (never the more permissive one)', async () => {
  const c = contract({ requiredPermissions: ['runtime.execute'] });
  const cb = countingBinding(c);
  const outcome = await executeResolvedContract(c, cb.binding, {
    subject: alice(),
    permissionDeclaration: PERMISSION_FREE,
    permissionManager: manager([{ id: 'a', effect: 'ALLOW', match: {} }]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'authorization');
  assert.match(outcome.error.message, /conflicting/);
  assert.equal(cb.calls(), 0);
});

test('M2: missing / fabricated subject is denied before the handler runs', async () => {
  const c = contract();
  for (const subject of [undefined, { kind: 'human', id: 'alice' }, { ...alice() }, 'alice']) {
    const cb = countingBinding(c);
    const outcome = await executeResolvedContract(c, cb.binding, {
      subject: subject as never,
      permissionDeclaration: PERMISSION_FREE,
      permissionManager: manager([{ id: 'a', effect: 'ALLOW', match: {} }]),
      input: { claimed_loss_amount: 15000 },
    });
    assert.equal(outcome.ok, false, JSON.stringify(subject));
    if (outcome.ok) return;
    assert.equal(outcome.stage, 'authorization');
    assert.equal(cb.calls(), 0);
  }
});

test('M2: missing permission manager is denied (no gate configured), handler never runs', async () => {
  const c = contract();
  const cb = countingBinding(c);
  const outcome = await executeResolvedContract(c, cb.binding, {
    subject: alice(),
    permissionDeclaration: PERMISSION_FREE,
    permissionManager: undefined as never,
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.stage, 'authorization');
  assert.equal(cb.calls(), 0);
});

test('M2: authenticated principal + explicit permission-free declaration executes; a principal-scoped grant authorizes only that principal', async () => {
  const free = contract();
  assert.equal(
    (
      await executeResolvedContract(free, bound(free), {
        subject: alice(),
        permissionDeclaration: PERMISSION_FREE,
        permissionManager: manager([]),
        input: { claimed_loss_amount: 15000 },
      })
    ).ok,
    true,
  );

  const c = contract({ requiredPermissions: ['runtime.execute'] });
  const rule = { id: 'g', effect: 'ALLOW' as const, match: { permission: Permissions.runtime.execute, principalId: 'alice' } };
  const mine = await executeResolvedContract(c, bound(c), {
    subject: alice(),
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([rule]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(mine.ok, true);
  const bobR = establishAuthenticatedPrincipal({ kind: 'human', id: 'bob' });
  if (!bobR.ok) throw bobR.error;
  const cb = countingBinding(c);
  const theirs = await executeResolvedContract(c, cb.binding, {
    subject: bobR.value,
    permissionDeclaration: declaredFrom(c),
    permissionManager: manager([rule]),
    input: { claimed_loss_amount: 15000 },
  });
  assert.equal(theirs.ok, false);
  if (theirs.ok) return;
  assert.equal(theirs.stage, 'execution');
  assert.equal(theirs.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
  assert.equal(cb.calls(), 0);
});
