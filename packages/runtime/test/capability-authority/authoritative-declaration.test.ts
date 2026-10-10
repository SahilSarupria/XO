import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PermissionManager,
  RuleBasedPolicy,
  PERMISSION_FREE,
  Permissions,
  attestAuthoritativeDeclaration,
  isAuthoritativeDeclarationFor,
  resolveAuthoritativeDeclaration,
  establishAuthenticatedPrincipal,
  type PermissionDeclaration,
  type PolicyRule,
} from '@xo/permissions';
import { type CapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import { executeResolvedContract, resolveContractBinding } from '../../src/capability-authority/contract-execution.js';
import { RuntimeCapabilityRegistry } from '../../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../../src/capability-authority/capability-binding-registration.js';
import { testSubject } from '../authz-helpers.js';

// P1.0 M2 remediation — Finding B: the shared execution boundary must not let a caller-supplied
// permission declaration replace or lower the authoritative requirement.

const denyAll = () => new PermissionManager({ policy: new RuleBasedPolicy([]) });

/** Contract whose COPIED `requiredPermissions` is empty — exactly the shape `contract-builder` produces when it defaults `?? []`. */
function contract(id = 'capability:needs-file'): SemanticCapabilityContract {
  return {
    id,
    name: 'Needs file',
    description: 'A capability whose authoritative node requires filesystem.read but whose contract copy is empty',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'deterministic',
    rules: [
      {
        sourceNodeId: 'decision:rule',
        kind: 'decision_node',
        condition: 'the file size exceeds 10',
        outcome: 'file readable',
        exceptionConditions: [],
        confidence: 0.9,
      },
    ],
    confidence: 0.9,
    sourceRefs: [],
    sourceXoirNodeIds: [id, 'decision:rule'],
    actionKnowledgeRefs: [],
  };
}

function spiedBinding(c: SemanticCapabilityContract): { binding: CapabilityBinding; calls: () => number } {
  const outcome = resolveContractBinding(c);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') throw new Error('unreachable');
  let n = 0;
  const original = outcome.binding;
  const binding = { ...original, evaluate: (input: unknown) => (n++, original.evaluate!(input as never)) } as CapabilityBinding;
  return { binding, calls: () => n };
}

test('B1 a hand-written permission-free declaration must not be accepted by the shared boundary', async () => {
  const c = contract();
  const { binding, calls } = spiedBinding(c);
  const forged = { kind: 'none' } as PermissionDeclaration; // plain structural object, never minted by an authoritative resolver
  const out = await executeResolvedContract(c, binding, {
    subject: testSubject(),
    permissionManager: denyAll(),
    permissionDeclaration: forged,
    input: { file_size: 50 },
  });
  assert.equal(out.ok, false, 'a forged permission-free declaration executed the capability');
  assert.equal(calls(), 0, 'the handler must not run');
});

test('B2 a JSON round-tripped declaration is a forgery too', async () => {
  const c = contract();
  const { binding, calls } = spiedBinding(c);
  const deserialized = JSON.parse(JSON.stringify(PERMISSION_FREE)) as PermissionDeclaration;
  const out = await executeResolvedContract(c, binding, {
    subject: testSubject(),
    permissionManager: denyAll(),
    permissionDeclaration: deserialized,
    input: { file_size: 50 },
  });
  assert.equal(out.ok, false);
  assert.equal(calls(), 0);
});

test('B3 the shared PERMISSION_FREE constant (valid for ANOTHER capability) cannot be replayed for this one', async () => {
  const c = contract();
  const { binding, calls } = spiedBinding(c);
  const out = await executeResolvedContract(c, binding, {
    subject: testSubject(),
    permissionManager: denyAll(),
    permissionDeclaration: PERMISSION_FREE,
    input: { file_size: 50 },
  });
  assert.equal(out.ok, false, 'a permission-free declaration resolved for a different capability was replayed');
  assert.equal(calls(), 0);
});

// ── Shared helpers for the remaining cases ──────────────────────────────

const FILE = Permissions.filesystem.read;
const allowAll: PolicyRule = { id: 'all', effect: 'ALLOW', match: {} };
const mgr = (...rules: PolicyRule[]) => new PermissionManager({ policy: new RuleBasedPolicy(rules) });
const mint = (raw: unknown, capabilityId: string): PermissionDeclaration =>
  resolveAuthoritativeDeclaration(raw, { capabilityId, origin: 'persisted-xoir-node' });
const alice = () => {
  const r = establishAuthenticatedPrincipal({ kind: 'human', id: 'alice' });
  if (!r.ok) throw r.error;
  return r.value;
};

test('B4: missing / null / malformed AUTHORITATIVE requirements are denied before the handler runs, even under an allow-all policy', async () => {
  for (const [label, raw] of [
    ['missing', undefined],
    ['null', null],
    ['string', 'filesystem.read'],
    ['object', {}],
    ['non-string entry', [1]],
    ['invalid id', ['NOT A PERMISSION']],
  ] as const) {
    const c = contract();
    const { binding, calls } = spiedBinding(c);
    const out = await executeResolvedContract(c, binding, {
      subject: testSubject(),
      permissionManager: mgr(allowAll),
      permissionDeclaration: mint(raw, c.id),
      input: { file_size: 50 },
    });
    assert.equal(out.ok, false, label);
    if (!out.ok) assert.equal(out.stage, 'authorization', label);
    assert.equal(calls(), 0, label);
  }
});

test('B5: a JavaScript caller that omits / nulls the declaration is denied (absent never becomes permission-free)', async () => {
  for (const missing of [undefined, null]) {
    const c = contract();
    const { binding, calls } = spiedBinding(c);
    const out = await executeResolvedContract(c, binding, {
      subject: testSubject(),
      permissionManager: mgr(allowAll),
      permissionDeclaration: missing as never,
      input: { file_size: 50 },
    });
    assert.equal(out.ok, false);
    assert.equal(calls(), 0);
  }
});

test('B6: an explicitly permission-free AUTHORITATIVE declaration still executes for a verified subject', async () => {
  const c = contract();
  const { binding, calls } = spiedBinding(c);
  const out = await executeResolvedContract(c, binding, {
    subject: alice(),
    permissionManager: mgr(), // deny-all policy: nothing to ask for, but the subject must still verify
    permissionDeclaration: mint([], c.id),
    input: { file_size: 50 },
  });
  assert.equal(out.ok, true);
  assert.equal(calls(), 1);
});

test('B7: permission-free still needs a verified actor ("no permissions" never means "no actor")', async () => {
  const c = contract();
  const { binding, calls } = spiedBinding(c);
  for (const subject of [undefined, { kind: 'human', id: 'alice' }, { ...alice() }]) {
    const out = await executeResolvedContract(c, binding, {
      subject: subject as never,
      permissionManager: mgr(allowAll),
      permissionDeclaration: mint([], c.id),
      input: { file_size: 50 },
    });
    assert.equal(out.ok, false);
  }
  assert.equal(calls(), 0);
});

test('B8: the authoritative declaration is enforced even when the contract COPY is empty (copy cannot weaken it)', async () => {
  const c = contract(); // copy: requiredPermissions []
  const decl = () => mint([FILE], c.id); // authoritative: requires filesystem.read
  const denied = spiedBinding(c);
  const noGrant = await executeResolvedContract(c, denied.binding, {
    subject: alice(),
    permissionManager: mgr(),
    permissionDeclaration: decl(),
    input: { file_size: 50 },
  });
  assert.equal(noGrant.ok, false);
  assert.equal(denied.calls(), 0);

  const wrongPrincipal = spiedBinding(c);
  const other = await executeResolvedContract(c, wrongPrincipal.binding, {
    subject: alice(),
    permissionManager: mgr({ id: 'g', effect: 'ALLOW', match: { permission: FILE, principalId: 'bob' } }),
    permissionDeclaration: decl(),
    input: { file_size: 50 },
  });
  assert.equal(other.ok, false);
  assert.equal(wrongPrincipal.calls(), 0);

  const allowed = spiedBinding(c);
  const granted = await executeResolvedContract(c, allowed.binding, {
    subject: alice(),
    permissionManager: mgr({ id: 'g', effect: 'ALLOW', match: { permission: FILE, principalId: 'alice' } }),
    permissionDeclaration: decl(),
    input: { file_size: 50 },
  });
  assert.equal(granted.ok, true);
  assert.equal(allowed.calls(), 1);
});

test('B9: a contract copy that demands MORE than the authoritative declaration is a conflict, never resolved to the weaker side', async () => {
  const c = { ...contract(), requiredPermissions: [FILE] };
  const { binding, calls } = spiedBinding(c);
  const out = await executeResolvedContract(c, binding, {
    subject: alice(),
    permissionManager: mgr(allowAll),
    permissionDeclaration: mint([], c.id),
    input: { file_size: 50 },
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error.message, /conflicting/);
  assert.equal(calls(), 0);
});

test('B10: a declaration minted for ANOTHER capability cannot be replayed (even a genuinely authoritative permission-free one)', async () => {
  const c = contract('capability:target');
  const { binding, calls } = spiedBinding(c);
  const out = await executeResolvedContract(c, binding, {
    subject: alice(),
    permissionManager: mgr(allowAll),
    permissionDeclaration: mint([], 'capability:some-other'),
    input: { file_size: 50 },
  });
  assert.equal(out.ok, false);
  assert.equal(calls(), 0);
});

test('B11: minting cannot be imitated — spread / frozen clone / untrusted origin / empty id all fail provenance', () => {
  const real = mint([FILE], 'cap:x');
  assert.equal(isAuthoritativeDeclarationFor(real, 'cap:x'), true);
  assert.equal(isAuthoritativeDeclarationFor(real, 'cap:y'), false);
  assert.equal(isAuthoritativeDeclarationFor({ ...real }, 'cap:x'), false);
  assert.equal(isAuthoritativeDeclarationFor(Object.freeze(JSON.parse(JSON.stringify(real))), 'cap:x'), false);
  assert.equal(isAuthoritativeDeclarationFor(PERMISSION_FREE, 'cap:x'), false);
  assert.equal(isAuthoritativeDeclarationFor(undefined, 'cap:x'), false);
  const badOrigin = resolveAuthoritativeDeclaration([], { capabilityId: 'cap:x', origin: 'attacker' as never });
  assert.equal(isAuthoritativeDeclarationFor(badOrigin, 'cap:x'), false);
  assert.equal(badOrigin.kind, 'unresolved');
  const noId = resolveAuthoritativeDeclaration([], { capabilityId: '', origin: 'persisted-xoir-node' });
  assert.equal(noId.kind, 'unresolved');
  // attesting never mints the shared constant itself: a permission-free attestation for x is not valid for y
  const attested = attestAuthoritativeDeclaration(PERMISSION_FREE, { capabilityId: 'cap:x', origin: 'installed-package-manifest' });
  assert.notEqual(attested, PERMISSION_FREE);
  assert.equal(isAuthoritativeDeclarationFor(attested, 'cap:x'), true);
  assert.equal(isAuthoritativeDeclarationFor(attested, 'cap:y'), false);
  assert.equal(isAuthoritativeDeclarationFor(PERMISSION_FREE, 'cap:x'), false);
});

test('B12: direct lower-level execution — a declaration smuggled on the executor request is ignored; registry-held requirements still gate the handler', async () => {
  const c = contract();
  const outcome = resolveContractBinding(c);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') return;
  let calls = 0;
  const original = outcome.binding;
  const binding = { ...original, evaluate: (i: unknown) => (calls++, original.evaluate!(i as never)) } as CapabilityBinding;

  const registry = new RuntimeCapabilityRegistry();
  const registered = registerResolvedCapabilityBinding(registry, c, binding, {
    additionalRequiredPermissions: [{ permission: FILE }],
  });
  assert.equal(registered.ok, true);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: mgr(), subject: alice() });
  const smuggled = {
    capabilityId: c.id,
    input: { file_size: 50 },
    permissionDeclaration: PERMISSION_FREE, // no such request field exists; must change nothing
    declaration: { kind: 'none' },
    requiredPermissions: [],
  };
  const result = await executor.execute(smuggled as never);
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test('B13: direct lower-level execution — an unknown capability, an unverified subject, and a registration without an explicit declaration are all refused', async () => {
  const c = contract();
  const { binding, calls } = spiedBinding(c);
  const registry = new RuntimeCapabilityRegistry();
  assert.equal(registerResolvedCapabilityBinding(registry, c, binding).ok, true); // explicit [] => permission-free
  assert.throws(() => new RuntimeCapabilityExecutor({ registry, permissionManager: mgr(allowAll), subject: undefined as never }));
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: mgr(), subject: alice() });
  assert.equal((await executor.execute({ capabilityId: 'cap:unknown', input: {} })).ok, false);
  // A raw registration with no explicit requiredPermissions array is a malformed registration, not "no requirements".
  const raw = registry.register({
    declaration: {
      capabilityId: 'cap:raw',
      inputContract: { description: 'i' },
      outputContract: { description: 'o' },
      handler: () => {
        calls();
        return 'ran';
      },
    },
  } as never);
  assert.equal(raw.ok, false);
  assert.equal((await executor.execute({ capabilityId: 'cap:raw', input: {} })).ok, false);
});
