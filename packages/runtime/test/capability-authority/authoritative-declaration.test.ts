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
import { ErrorCode } from '@xo/errors';
import {
  executeResolvedContract,
  resolveContractBinding,
  type ExecuteResolvedContractOutcome,
} from '../../src/capability-authority/contract-execution.js';
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

/**
 * Proves the denial happened AT THE PROVENANCE CHECK of the authorization boundary — not at some earlier,
 * unrelated validation (bad subject, registration, binding) that would make the test pass for the wrong reason.
 */
function assertDeniedForProvenance(out: ExecuteResolvedContractOutcome): void {
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.stage, 'authorization', 'must be refused at the authorization stage, before registration');
  assert.equal(out.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
  assert.match(out.error.message, /not resolved from an authoritative source/, 'denied for the wrong reason');
}

/** Control: the SAME contract/binding/subject/manager/input with a genuinely minted declaration executes — so the denial above is attributable to provenance alone. */
async function assertControlExecutes(c: SemanticCapabilityContract, binding: CapabilityBinding, calls: () => number): Promise<void> {
  const before = calls();
  const out = await executeResolvedContract(c, binding, {
    subject: testSubject(),
    permissionManager: denyAll(),
    permissionDeclaration: resolveAuthoritativeDeclaration([], { capabilityId: c.id, origin: 'persisted-xoir-node' }),
    input: { file_size: 50 },
  });
  assert.equal(out.ok, true, 'control with a minted permission-free declaration should execute');
  assert.equal(calls(), before + 1);
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
  assertDeniedForProvenance(out);
  assert.equal(calls(), 0, 'the handler must not run');
  await assertControlExecutes(c, binding, calls);
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
  assertDeniedForProvenance(out);
  assert.equal(calls(), 0);
  await assertControlExecutes(c, binding, calls);
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
  assertDeniedForProvenance(out);
  assert.equal(calls(), 0);
  await assertControlExecutes(c, binding, calls);
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

// ── Decision-point provenance reaches EVERY consumer, not only executeResolvedContract ──

function registryWith(capabilityId: string, calls: { n: number }, requiredPermissions: readonly string[] = []): RuntimeCapabilityRegistry {
  const registry = new RuntimeCapabilityRegistry();
  const registered = registry.register({
    declaration: {
      capabilityId,
      inputContract: { description: 'in' },
      outputContract: { description: 'out' },
      handler: async () => {
        calls.n++;
        return { ok: true, value: { done: true } } as never;
      },
    } as never,
    requiredPermissions: requiredPermissions.map((permission) => ({ permission })) as never,
  });
  assert.ok(registered.ok, registered.ok ? '' : registered.error.message);
  return registry;
}

test('B14: the registry mints its declaration per call, per capability; copies and cross-capability replays do not verify', () => {
  const calls = { n: 0 };
  const registry = registryWith('cap-a', calls);
  registry.register({
    declaration: {
      capabilityId: 'cap-b',
      inputContract: { description: 'in' },
      outputContract: { description: 'out' },
      handler: async () => ({ ok: true, value: 1 }) as never,
    } as never,
    requiredPermissions: [],
  });
  const a = registry.permissionDeclaration('cap-a');
  assert.equal(a.kind, 'none');
  assert.equal(isAuthoritativeDeclarationFor(a, 'cap-a'), true);
  assert.equal(isAuthoritativeDeclarationFor(a, 'cap-b'), false, 'minted for cap-a, cannot verify for cap-b');
  assert.equal(isAuthoritativeDeclarationFor(JSON.parse(JSON.stringify(a)), 'cap-a'), false, 'JSON clone');
  assert.equal(isAuthoritativeDeclarationFor({ ...a }, 'cap-a'), false, 'spread copy');
  assert.notEqual(registry.permissionDeclaration('cap-a'), a, 'fresh object per call — nothing shared to replay');
  assert.equal(isAuthoritativeDeclarationFor(PERMISSION_FREE, 'cap-a'), false);
});

test('B15: executor boundary — a registry whose declaration lookup is tampered to return a forged permission-free literal is denied; handler never runs', async () => {
  const calls = { n: 0 };
  const registry = registryWith('cap-a', calls, [FILE]); // really requires filesystem.read
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: denyAll(), subject: testSubject() });
  // Control first: the genuine (minted, `required`) declaration is enforced ⇒ denied by POLICY (no grant), handler 0.
  const genuine = await executor.execute({ capabilityId: 'cap-a', input: {} });
  assert.equal(genuine.ok, false);
  assert.match(!genuine.ok ? genuine.error.message : '', /was not granted/);
  assert.equal(calls.n, 0);

  // Now forge: replace the lookup with the shared constant / a literal / a JSON clone.
  for (const forged of [PERMISSION_FREE, { kind: 'none' }, JSON.parse(JSON.stringify(PERMISSION_FREE))]) {
    (registry as unknown as { permissionDeclaration: (id: string) => unknown }).permissionDeclaration = () => forged;
    const out = await executor.execute({ capabilityId: 'cap-a', input: {} });
    assert.equal(out.ok, false, 'a forged permission-free declaration reached the handler');
    assert.equal(!out.ok && out.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
    assert.match(!out.ok ? out.error.message : '', /not resolved from an authoritative source/, 'denied for the wrong reason');
    assert.equal(calls.n, 0, 'handler must never run on a forged declaration');
  }
});

test('B16: executor boundary — a declaration minted for ANOTHER capability, returned by a tampered registry, is denied', async () => {
  const calls = { n: 0 };
  const registry = registryWith('cap-a', calls);
  const foreign = resolveAuthoritativeDeclaration([], { capabilityId: 'cap-other', origin: 'trusted-host-registration' });
  (registry as unknown as { permissionDeclaration: (id: string) => unknown }).permissionDeclaration = () => foreign;
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: denyAll(), subject: testSubject() });
  const out = await executor.execute({ capabilityId: 'cap-a', input: {} });
  assert.equal(out.ok, false);
  assert.match(!out.ok ? out.error.message : '', /not resolved from an authoritative source/);
  assert.equal(calls.n, 0);
});
