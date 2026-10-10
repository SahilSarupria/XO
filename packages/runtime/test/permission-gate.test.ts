import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import { CapabilityPermissionRegistry, InMemoryPermissionStore, PermissionManager, Permissions, RuleBasedPolicy } from '@xo/permissions';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { allowAllPermissionGate, type PermissionGate } from '../src/permissions/permission-gate.interface.js';
import { createPermissionManagerGate } from '../src/permissions/permission-manager-gate.js';
import { testSubject } from './authz-helpers.js';
import { buildContractLawyerBundle, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';

function baseRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_1'),
    capabilityId: 'contract_analysis',
    input: 'Please review this NDA for risk.',
    environment: {
      environmentId: EnvironmentId('env_1'),
      hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
      provider: 'anthropic',
      tokenBudget: 8000,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('permission gate: with NO gate configured the pipeline denies by default (P1.0 M2) — provider never invoked', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({
      text: 'should never be reached',
      usage: { inputTokens: 10, outputTokens: 5 },
      modelUsed: 'test-model',
      finishReason: 'stop',
    });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const result = await engine.execute(baseRequest());
    assert.equal(result.session.status, 'failed');
    assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.match(result.error?.message ?? '', /no permission gate is configured/);
    assert.equal(provider.requests.length, 0);
  });
});

test('permission gate: a malformed/throwing gate is a denial, never an allow', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    for (const gate of [
      {} as unknown as PermissionGate,
      {
        check: async () => {
          throw new Error('boom');
        },
      } as PermissionGate,
      { check: async () => ({}) } as unknown as PermissionGate,
      { check: async () => ({ allowed: 'yes' }) } as unknown as PermissionGate,
    ]) {
      const provider = new ScriptedModelProvider();
      provider.setResponse({ text: 'never', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'test-model', finishReason: 'stop' });
      const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
      const result = await engine.execute(baseRequest());
      assert.equal(result.session.status, 'failed');
      assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
      assert.equal(provider.requests.length, 0);
    }
  });
});

test('permission gate: a denying gate blocks execution with RUNTIME_PERMISSION_DENIED, before any provider call', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({
      text: 'should never be reached',
      usage: { inputTokens: 10, outputTokens: 5 },
      modelUsed: 'test-model',
      finishReason: 'stop',
    });

    const denyingGate: PermissionGate = {
      async check() {
        return { allowed: false, reason: 'filesystem.read was denied' };
      },
    };

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: denyingGate });
    const result = await engine.execute(baseRequest());

    assert.equal(result.session.status, 'failed');
    assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.match(result.error?.message ?? '', /filesystem\.read was denied/);
    assert.equal(provider.requests.length, 0);
  });
});

test('permission gate: allowAllPermissionGate always allows', async () => {
  const verdict = await allowAllPermissionGate.check({ name: 'anything', version: '1.0.0' }, 'any.capability', baseRequest());
  assert.equal(verdict.allowed, true);
});

test('permission gate: createPermissionManagerGate integrates a real @xo/permissions PermissionManager end-to-end', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });

    const capabilityRegistry = new CapabilityPermissionRegistry();
    capabilityRegistry.register('contract_analysis', [{ permission: Permissions.filesystem.read }]);

    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]), store: new InMemoryPermissionStore() });
    const gate = createPermissionManagerGate({ manager, subject: testSubject(), registry: capabilityRegistry });

    // Not yet granted -> denied.
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
    const denied = await engine.execute(baseRequest({ requestId: RequestId('req_denied') }));
    assert.equal(denied.session.status, 'failed');
    assert.equal(denied.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.equal(provider.requests.length, 0);

    // Grant it administratively, then the same capability executes normally.
    await manager.grant({
      packageId: PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`),
      permission: Permissions.filesystem.read,
    });
    const allowed = await engine.execute(baseRequest({ requestId: RequestId('req_allowed') }));
    assert.equal(allowed.session.status, 'completed');
    assert.equal(provider.requests.length, 1);
  });
});

test('permission gate: a capability with NO permission declaration anywhere is DENIED (missing is never unrestricted)', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'never', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });

    const capabilityRegistry = new CapabilityPermissionRegistry(); // nothing registered
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'allow-all', effect: 'ALLOW', match: {} }]) });
    const gate = createPermissionManagerGate({ manager, subject: testSubject(), registry: capabilityRegistry });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
    const result = await engine.execute(baseRequest());
    assert.equal(result.session.status, 'failed');
    assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.match(result.error?.message ?? '', /declares no permission requirements/);
    assert.equal(provider.requests.length, 0);
  });
});

test('permission gate: an EXPLICIT permission-free declaration (registry register(id, [])) is allowed without any grant', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });

    const capabilityRegistry = new CapabilityPermissionRegistry();
    capabilityRegistry.register('contract_analysis', []);
    const gate = createPermissionManagerGate({
      manager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
      subject: testSubject(),
      registry: capabilityRegistry,
    });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
    const result = await engine.execute(baseRequest());
    assert.equal(result.session.status, 'completed');
  });
});

test('permission gate: createPermissionManagerGate refuses to be built without a verified subject or a manager', () => {
  const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
  for (const subject of [
    undefined,
    null,
    { kind: 'human', id: 'alice' },
    { kind: 'trusted-context', context: 'local-operator' },
    'alice',
  ]) {
    assert.throws(() => createPermissionManagerGate({ manager, subject: subject as never }), /verified/);
  }
  assert.throws(() => createPermissionManagerGate({ manager: undefined as never, subject: testSubject() }), /PermissionManager/);
});
