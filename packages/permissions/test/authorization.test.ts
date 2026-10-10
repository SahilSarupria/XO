import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import {
  authorizeCapabilityExecution,
  establishAuthenticatedPrincipal,
  establishTrustedExecutionContext,
  isTrustedExecutionContext,
  PermissionManager,
  PERMISSION_FREE,
  Permissions,
  reconcilePermissionDeclarations,
  declarationCoversCopy,
  resolveDeclaredPermissionIds,
  RuleBasedPolicy,
  pathScope,
  type PermissionDeclaration,
  type PolicyRule,
} from '../src/index.js';

function principal(id = 'alice', kind: 'human' | 'service' = 'human', orgId?: string) {
  const r = establishAuthenticatedPrincipal({ kind, id, ...(orgId !== undefined ? { orgId } : {}) });
  assert.ok(r.ok);
  return r.value;
}
const manager = (rules: readonly PolicyRule[] = []) => new PermissionManager({ policy: new RuleBasedPolicy(rules) });
const requester = { packageId: PackageId('pkg@1.0.0'), capabilityId: 'cap-a' };
const required = (...ids: string[]): PermissionDeclaration => {
  const d = resolveDeclaredPermissionIds(ids, 'test');
  assert.equal(d.kind, 'required');
  return d;
};
const allowFor = (principalId: string, permission = Permissions.filesystem.read): PolicyRule => ({
  id: `allow-${principalId}`,
  effect: 'ALLOW',
  match: { permission, principalId },
});

// ── declaration resolution ──
test('declaration: [] is the explicit permission-free declaration; missing is NOT', () => {
  assert.deepEqual(resolveDeclaredPermissionIds([], 't'), PERMISSION_FREE);
  for (const bad of [undefined, null]) assert.equal(resolveDeclaredPermissionIds(bad, 't').kind, 'unresolved');
});
test('declaration: malformed shapes and unknown/invalid ids are unresolved, never none', () => {
  for (const bad of ['filesystem.read', {}, 7, [1], ['not a permission'], [''], ['filesystem.read', null]]) {
    assert.equal(resolveDeclaredPermissionIds(bad, 't').kind, 'unresolved', JSON.stringify(bad));
  }
});
test('declaration: valid ids resolve to required; duplicates collapse', () => {
  const d = resolveDeclaredPermissionIds(['filesystem.read', 'filesystem.read', 'network.connect'], 't');
  assert.equal(d.kind, 'required');
  if (d.kind === 'required') assert.equal(d.requirements.length, 2);
});
test('declaration: conflicting copies are unresolved (never the permissive one)', () => {
  const none = PERMISSION_FREE;
  const some = required('filesystem.read');
  assert.equal(reconcilePermissionDeclarations(none, some, 't').kind, 'unresolved');
  assert.equal(reconcilePermissionDeclarations(some, none, 't').kind, 'unresolved');
  assert.equal(reconcilePermissionDeclarations(some, required('network.connect'), 't').kind, 'unresolved');
  assert.equal(reconcilePermissionDeclarations(some, required('filesystem.read'), 't').kind, 'required');
  assert.equal(reconcilePermissionDeclarations(none, none, 't').kind, 'none');
  assert.equal(reconcilePermissionDeclarations(none, resolveDeclaredPermissionIds(undefined, 't'), 't').kind, 'unresolved');
});

// ── trusted context ──
test('trusted context: only the factory mints a verifiable context; copies/JSON do not verify', () => {
  const ctx = establishTrustedExecutionContext('local-operator');
  assert.ok(isTrustedExecutionContext(ctx));
  assert.equal(isTrustedExecutionContext({ ...ctx }), false);
  assert.equal(isTrustedExecutionContext(JSON.parse(JSON.stringify(ctx))), false);
  assert.equal(isTrustedExecutionContext({ kind: 'trusted-context', context: 'local-operator' }), false);
  assert.throws(() => establishTrustedExecutionContext('root' as never));
});

// ── authorizeCapabilityExecution: fail-closed matrix ──
test('deny: no manager (no gate configured)', async () => {
  const out = await authorizeCapabilityExecution({ manager: undefined, subject: principal(), requester, declaration: PERMISSION_FREE });
  assert.deepEqual([out.allowed, !out.allowed && out.code], [false, 'no-policy']);
});
test('deny: missing / fabricated / plain-snapshot / string subject', async () => {
  const fabricated = { kind: 'human', id: 'alice' };
  const forgedCopy = { ...principal() };
  for (const subject of [undefined, null, fabricated, forgedCopy, 'alice', { kind: 'trusted-context', context: 'local-operator' }]) {
    const out = await authorizeCapabilityExecution({
      manager: manager([allowFor('alice')]),
      subject,
      requester,
      declaration: PERMISSION_FREE,
    });
    assert.deepEqual([out.allowed, !out.allowed && out.code], [false, 'no-subject'], JSON.stringify(subject));
  }
});
test('deny: missing requester identity', async () => {
  const out = await authorizeCapabilityExecution({
    manager: manager(),
    subject: principal(),
    requester: { packageId: PackageId(''), capabilityId: 'x' },
    declaration: PERMISSION_FREE,
  });
  assert.equal(!out.allowed && out.code, 'no-requester');
  const out2 = await authorizeCapabilityExecution({
    manager: manager(),
    subject: principal(),
    requester: { packageId: PackageId('p@1') } as never,
    declaration: PERMISSION_FREE,
  });
  assert.equal(!out2.allowed && out2.code, 'no-requester');
});
test('deny: absent or unresolved declaration, even with a matching allow-everything policy', async () => {
  const everything: PolicyRule = { id: 'all', effect: 'ALLOW', match: {} };
  for (const declaration of [
    undefined,
    resolveDeclaredPermissionIds(undefined, 't'),
    { kind: 'bogus' } as never,
    { kind: 'required', requirements: [] } as never,
  ]) {
    const out = await authorizeCapabilityExecution({ manager: manager([everything]), subject: principal(), requester, declaration });
    assert.deepEqual([out.allowed, !out.allowed && out.code], [false, 'unresolved-declaration']);
  }
});
test('allow: explicitly permission-free capability needs a verified subject but no grant', async () => {
  const out = await authorizeCapabilityExecution({ manager: manager(), subject: principal(), requester, declaration: PERMISSION_FREE });
  assert.equal(out.allowed, true);
  const op = await authorizeCapabilityExecution({
    manager: manager(),
    subject: establishTrustedExecutionContext('local-operator'),
    requester,
    declaration: PERMISSION_FREE,
  });
  assert.equal(op.allowed, true);
});
test('deny: valid principal, no applicable rule (principal alone grants nothing)', async () => {
  const out = await authorizeCapabilityExecution({
    manager: manager(),
    subject: principal(),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(!out.allowed && out.code, 'permission-denied');
});
test('allow: principal-scoped rule for the right principal; deny for another principal', async () => {
  const m = manager([allowFor('alice')]);
  const ok1 = await authorizeCapabilityExecution({
    manager: m,
    subject: principal('alice'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(ok1.allowed, true);
  const no = await authorizeCapabilityExecution({
    manager: m,
    subject: principal('mallory'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(!no.allowed && no.code, 'permission-denied');
});
test('deny: principal-scoped rule never matches a trusted context (no principal)', async () => {
  const out = await authorizeCapabilityExecution({
    manager: manager([allowFor('alice')]),
    subject: establishTrustedExecutionContext('local-operator'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(!out.allowed && out.code, 'permission-denied');
});
test('allow: a rule without a principal matcher applies to a trusted context (CLI --grant model)', async () => {
  const out = await authorizeCapabilityExecution({
    manager: manager([{ id: 'g', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } }]),
    subject: establishTrustedExecutionContext('local-operator'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(out.allowed, true);
});
test('deny: wrong permission', async () => {
  const out = await authorizeCapabilityExecution({
    manager: manager([allowFor('alice', Permissions.network.connect)]),
    subject: principal('alice'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(!out.allowed && out.code, 'permission-denied');
});
test('deny: wrong capability / wrong package (requester pinned by rule)', async () => {
  const rule: PolicyRule = {
    id: 'r',
    effect: 'ALLOW',
    match: { permission: Permissions.filesystem.read, principalId: 'alice', capabilityId: 'cap-other' },
  };
  const out = await authorizeCapabilityExecution({
    manager: manager([rule]),
    subject: principal('alice'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(!out.allowed && out.code, 'permission-denied');
  const rule2: PolicyRule = {
    id: 'r2',
    effect: 'ALLOW',
    match: { permission: Permissions.filesystem.read, principalId: 'alice', packageId: PackageId('other@1.0.0') },
  };
  const out2 = await authorizeCapabilityExecution({
    manager: manager([rule2]),
    subject: principal('alice'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(!out2.allowed && out2.code, 'permission-denied');
});
test('deny: wrong resource scope; allow: contained scope', async () => {
  const rule: PolicyRule = {
    id: 'r',
    effect: 'ALLOW',
    match: { permission: Permissions.filesystem.read, principalId: 'alice', scope: pathScope('/workspace') },
  };
  const m = manager([rule]);
  const declFor = (path: string): PermissionDeclaration => ({
    kind: 'required',
    requirements: [{ permission: Permissions.filesystem.read, scope: pathScope(path) }],
  });
  const inside = await authorizeCapabilityExecution({
    manager: m,
    subject: principal('alice'),
    requester,
    declaration: declFor('/workspace/project'),
  });
  assert.equal(inside.allowed, true);
  const outside = await authorizeCapabilityExecution({ manager: m, subject: principal('alice'), requester, declaration: declFor('/etc') });
  assert.equal(!outside.allowed && outside.code, 'permission-denied');
});
test('deny: every requirement must be allowed (one missing denies all)', async () => {
  const out = await authorizeCapabilityExecution({
    manager: manager([allowFor('alice')]),
    subject: principal('alice'),
    requester,
    declaration: required('filesystem.read', 'network.connect'),
  });
  assert.equal(!out.allowed && out.permission, 'network.connect');
});
test('deny: an explicit DENY rule beats an allow for the same principal', async () => {
  const m = manager([
    allowFor('alice'),
    { id: 'deny', effect: 'DENY', match: { permission: Permissions.filesystem.read, principalId: 'alice' }, priority: 1 },
  ]);
  const out = await authorizeCapabilityExecution({
    manager: m,
    subject: principal('alice'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(out.allowed, false);
});
test('deny: PROMPT is a denial', async () => {
  const m = manager([{ id: 'p', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
  const out = await authorizeCapabilityExecution({ manager: m, subject: principal(), requester, declaration: required('filesystem.read') });
  assert.equal(out.allowed, false);
});
test('deny: a throwing policy is denied, not propagated and not allowed', async () => {
  const throwing = new PermissionManager({
    policy: {
      evaluate: () => {
        throw new Error('boom');
      },
    },
  });
  const out = await authorizeCapabilityExecution({
    manager: throwing,
    subject: principal(),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.deepEqual([out.allowed, !out.allowed && out.code], [false, 'evaluation-error']);
});
test('orgId is a label only: a rule for another principal id does not match by org', async () => {
  const out = await authorizeCapabilityExecution({
    manager: manager([allowFor('alice')]),
    subject: principal('bob', 'human', 'alice'),
    requester,
    declaration: required('filesystem.read'),
  });
  assert.equal(out.allowed, false);
});
test('principalKind rules match kind only', async () => {
  const m = manager([{ id: 'svc', effect: 'ALLOW', match: { permission: Permissions.filesystem.read, principalKind: 'service' } }]);
  assert.equal(
    (
      await authorizeCapabilityExecution({
        manager: m,
        subject: principal('bot', 'service'),
        requester,
        declaration: required('filesystem.read'),
      })
    ).allowed,
    true,
  );
  assert.equal(
    (
      await authorizeCapabilityExecution({
        manager: m,
        subject: principal('alice', 'human'),
        requester,
        declaration: required('filesystem.read'),
      })
    ).allowed,
    false,
  );
});

test('declarationCoversCopy: may add requirements, may never drop or contradict the copy', () => {
  const none = PERMISSION_FREE;
  const fs = required('filesystem.read');
  assert.equal(declarationCoversCopy(fs, none, 't').kind, 'required'); // stricter than the copy: fine
  assert.equal(declarationCoversCopy(fs, fs, 't').kind, 'required');
  assert.equal(declarationCoversCopy(none, fs, 't').kind, 'unresolved'); // copy needs more than declared
  assert.equal(declarationCoversCopy(required('network.connect'), fs, 't').kind, 'unresolved');
  assert.equal(declarationCoversCopy(none, none, 't').kind, 'none');
  assert.equal(declarationCoversCopy(resolveDeclaredPermissionIds(undefined, 't'), none, 't').kind, 'unresolved');
  assert.equal(declarationCoversCopy(none, resolveDeclaredPermissionIds(undefined, 't'), 't').kind, 'unresolved');
});
