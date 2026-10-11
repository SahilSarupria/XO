import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok } from '@xo/types';
import { establishAuthenticatedPrincipal, PermissionManager, Permissions, RuleBasedPolicy, type PolicyRule } from '@xo/permissions';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../src/capability-authority/runtime-capability-executor.js';
import { testSubject } from './authz-helpers.js';

const principal = (id = 'alice') => {
  const r = establishAuthenticatedPrincipal({ kind: 'human', id });
  if (!r.ok) throw r.error;
  return r.value;
};
const mgr = (rules: readonly PolicyRule[] = []) => new PermissionManager({ policy: new RuleBasedPolicy(rules) });

function registryWith(requiredPermissions: unknown) {
  const registry = new RuntimeCapabilityRegistry();
  let calls = 0;
  const registered = registry.register({
    declaration: {
      capabilityId: 'cap',
      inputContract: { description: 'in' },
      outputContract: { description: 'out' },
      handler: async () => {
        calls += 1;
        return ok('done');
      },
    },
    requiredPermissions: requiredPermissions as never,
  });
  return { registry, registered, calls: () => calls };
}

test('M2 registry: a registration without an explicit requiredPermissions array is rejected', () => {
  for (const missing of [undefined, null, 'filesystem.read', {}]) {
    const { registry, registered } = registryWith(missing);
    assert.equal(registered.ok, false);
    assert.equal(registry.has('cap'), false);
  }
});

test('M2 registry: permissionDeclaration is unresolved for unknown ids, none for [], required otherwise', () => {
  const free = registryWith([]);
  assert.equal(free.registry.permissionDeclaration('cap').kind, 'none');
  assert.equal(free.registry.permissionDeclaration('nope').kind, 'unresolved');
  const req = registryWith([{ permission: Permissions.filesystem.read }]);
  assert.equal(req.registry.permissionDeclaration('cap').kind, 'required');
});

test('M2 registry: re-registering as permission-free never loosens an earlier requirement', () => {
  const { registry } = registryWith([{ permission: Permissions.filesystem.read }]);
  registry.register({
    declaration: {
      capabilityId: 'cap',
      inputContract: { description: 'i' },
      outputContract: { description: 'o' },
      handler: async () => ok(1),
    },
    requiredPermissions: [],
  });
  assert.equal(registry.permissionDeclaration('cap').kind, 'required');
});

test('M2 executor: cannot be constructed without a verified subject or a manager', () => {
  const { registry } = registryWith([]);
  for (const subject of [undefined, null, { kind: 'human', id: 'alice' }, { ...principal() }, 'alice']) {
    assert.throws(() => new RuntimeCapabilityExecutor({ registry, permissionManager: mgr(), subject: subject as never }), /subject/);
  }
  assert.throws(
    () => new RuntimeCapabilityExecutor({ registry, permissionManager: undefined as never, subject: testSubject() }),
    /PermissionManager/,
  );
});

test('M2 executor: a permission-free capability runs for a verified subject; handler runs exactly once', async () => {
  const { registry, calls } = registryWith([]);
  for (const subject of [principal(), testSubject()]) {
    const r = await new RuntimeCapabilityExecutor({ registry, permissionManager: mgr(), subject }).execute({
      capabilityId: 'cap',
      input: {},
    });
    assert.equal(r.ok, true);
  }
  assert.equal(calls(), 2);
});

test('M2 executor: denied (no grant / other principal / unknown capability) never invokes the handler', async () => {
  const { registry, calls } = registryWith([{ permission: Permissions.filesystem.read }]);
  const rule: PolicyRule = { id: 'g', effect: 'ALLOW', match: { permission: Permissions.filesystem.read, principalId: 'alice' } };

  const noGrant = await new RuntimeCapabilityExecutor({ registry, permissionManager: mgr(), subject: principal() }).execute({
    capabilityId: 'cap',
    input: {},
  });
  assert.equal(!noGrant.ok && noGrant.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
  const other = await new RuntimeCapabilityExecutor({ registry, permissionManager: mgr([rule]), subject: principal('mallory') }).execute({
    capabilityId: 'cap',
    input: {},
  });
  assert.equal(!other.ok && other.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
  const unknown = await new RuntimeCapabilityExecutor({ registry, permissionManager: mgr([rule]), subject: principal() }).execute({
    capabilityId: 'ghost',
    input: {},
  });
  assert.equal(unknown.ok, false);
  assert.equal(calls(), 0);

  const allowed = await new RuntimeCapabilityExecutor({ registry, permissionManager: mgr([rule]), subject: principal() }).execute({
    capabilityId: 'cap',
    input: {},
  });
  assert.equal(allowed.ok, true);
  assert.equal(calls(), 1);
});

test('M2 executor: a caller-supplied requesterPackageId/context cannot grant authority — only the policy can', async () => {
  const { registry, calls } = registryWith([{ permission: Permissions.filesystem.read }]);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: mgr(), subject: principal() });
  const r = await executor.execute({
    capabilityId: 'cap',
    input: {},
    requesterPackageId: 'admin@9.9.9',
    context: { environment: 'production', admin: true },
  });
  assert.equal(r.ok, false);
  assert.equal(calls(), 0);
});

test('M2 executor: a throwing policy denies; handler never runs', async () => {
  const { registry, calls } = registryWith([{ permission: Permissions.filesystem.read }]);
  const throwing = new PermissionManager({
    policy: {
      evaluate: () => {
        throw new Error('boom');
      },
    },
  });
  const r = await new RuntimeCapabilityExecutor({ registry, permissionManager: throwing, subject: principal() }).execute({
    capabilityId: 'cap',
    input: {},
  });
  assert.equal(!r.ok && r.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
  assert.equal(calls(), 0);
  void err;
});
