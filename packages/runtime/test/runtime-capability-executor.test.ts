import { test } from 'node:test';
import { testSubject } from './authz-helpers.js';
import assert from 'node:assert/strict';
import { ok, err } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { PermissionManager, RuleBasedPolicy, Permissions, type PolicyRule } from '@xo/permissions';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor, NATIVE_CAPABILITY_REQUESTER } from '../src/capability-authority/runtime-capability-executor.js';
import type { RuntimeCapabilityDeclaration } from '../src/capability-authority/runtime-capability-declaration.js';

function declaration(overrides: Partial<RuntimeCapabilityDeclaration> = {}): RuntimeCapabilityDeclaration {
  return {
    capabilityId: 'echo',
    inputContract: { description: 'Any string.' },
    outputContract: { description: 'The same string, unchanged.' },
    handler: async (input) => ok(input),
    ...overrides,
  };
}

function managerWithRules(rules: readonly PolicyRule[]): PermissionManager {
  return new PermissionManager({ policy: new RuleBasedPolicy(rules) });
}

test('a registered capability with no permission requirements executes successfully', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({ declaration: declaration(), requiredPermissions: [] });
  const manager = managerWithRules([]); // default-deny policy, but irrelevant: no requirements are registered for "echo"
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'echo', input: 'hello' });
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.value, { capabilityId: 'echo', output: 'hello' });
});

test('unknown capability id fails closed with RUNTIME_CAPABILITY_NOT_FOUND and never reaches the handler', async () => {
  const registry = new RuntimeCapabilityRegistry();
  let handlerCalled = false;
  registry.register({
    declaration: declaration({
      handler: async (i) => {
        handlerCalled = true;
        return ok(i);
      },
    }),
    requiredPermissions: [],
  });
  const manager = managerWithRules([]);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'nonexistent', input: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.RUNTIME_CAPABILITY_NOT_FOUND);
  assert.equal(handlerCalled, false);
});

test('a capability requiring a permission executes when the permission is granted', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: declaration({ capabilityId: 'read_file' }),
    requiredPermissions: [{ permission: Permissions.filesystem.read }],
  });
  const manager = managerWithRules([{ id: 'allow-fs-read', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } }]);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'read_file', input: {} });
  assert.ok(result.ok);
});

test('permission denial prevents execution — the handler is never invoked', async () => {
  const registry = new RuntimeCapabilityRegistry();
  let handlerCalled = false;
  registry.register({
    declaration: declaration({
      capabilityId: 'delete_file',
      handler: async (i) => {
        handlerCalled = true;
        return ok(i);
      },
    }),
    requiredPermissions: [{ permission: Permissions.filesystem.delete }],
  });
  const manager = managerWithRules([]); // no ALLOW rule -> default-deny
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'delete_file', input: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
  assert.equal(handlerCalled, false);
});

test('a PROMPT policy decision is treated as a denial (this class never triggers interactive consent)', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: declaration({ capabilityId: 'send_email' }),
    requiredPermissions: [{ permission: Permissions.network.connect }],
  });
  const manager = managerWithRules([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.network.connect } }]);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'send_email', input: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
});

test('an optional permission requirement that is denied does not block execution', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: declaration({ capabilityId: 'best_effort_log' }),
    requiredPermissions: [{ permission: Permissions.environment.read, optional: true }],
  });
  const manager = managerWithRules([]); // denies the optional permission
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'best_effort_log', input: 'x' });
  assert.ok(result.ok);
});

test('multiple required permissions must ALL be granted — one denial blocks the whole call', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: declaration({ capabilityId: 'multi_perm' }),
    requiredPermissions: [{ permission: Permissions.filesystem.read }, { permission: Permissions.network.connect }],
  });
  // Only filesystem.read is allowed; network.connect is not.
  const manager = managerWithRules([{ id: 'allow-fs-read', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } }]);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'multi_perm', input: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.RUNTIME_PERMISSION_DENIED);
});

test('a handler that throws is caught and reported as RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, not an uncaught exception', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: declaration({
      capabilityId: 'broken',
      handler: async () => {
        throw new Error('boom');
      },
    }),
    requiredPermissions: [],
  });
  const manager = managerWithRules([]);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'broken', input: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE);
});

test('a handler returning err(...) is propagated as-is, not wrapped/reinterpreted', async () => {
  const registry = new RuntimeCapabilityRegistry();
  const businessError = new RuntimeError(ErrorCode.RUNTIME_INVALID_REQUEST, 'bad input shape');
  registry.register({
    declaration: declaration({ capabilityId: 'validating', handler: async () => err(businessError) }),
    requiredPermissions: [],
  });
  const manager = managerWithRules([]);
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  const result = await executor.execute({ capabilityId: 'validating', input: {} });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, businessError);
});

test('permission checks for a native capability go through the real PermissionManager.check — not bypassed or short-circuited', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: declaration({ capabilityId: 'audited' }),
    requiredPermissions: [{ permission: Permissions.secrets.read }],
  });
  let checkedRequester: string | undefined;
  const manager = new PermissionManager({
    policy: {
      evaluate(request) {
        checkedRequester = request.requester.packageId;
        return { effect: 'ALLOW', reason: 'test-observed', ruleId: 'test-observed' };
      },
    },
  });
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  await executor.execute({ capabilityId: 'audited', input: {} });
  assert.equal(checkedRequester, NATIVE_CAPABILITY_REQUESTER);
});

test('requesterPackageId override changes only the audit attribution, not which permission is checked', async () => {
  const registry = new RuntimeCapabilityRegistry();
  registry.register({
    declaration: declaration({ capabilityId: 'audited2' }),
    requiredPermissions: [{ permission: Permissions.secrets.read }],
  });
  let seenPermission: string | undefined;
  let seenRequester: string | undefined;
  const manager = new PermissionManager({
    policy: {
      evaluate(request) {
        seenPermission = request.permission;
        seenRequester = request.requester.packageId;
        return { effect: 'ALLOW', reason: 'test-observed', ruleId: 'test-observed' };
      },
    },
  });
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: manager, subject: testSubject() });

  await executor.execute({ capabilityId: 'audited2', input: {}, requesterPackageId: 'my-host-subsystem' });
  assert.equal(seenRequester, 'my-host-subsystem');
  assert.equal(seenPermission, Permissions.secrets.read);
});
