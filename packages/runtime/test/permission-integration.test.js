import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import { InMemoryPermissionStore, PermissionManager, Permissions, RuleBasedPolicy, pathScope } from '@xo/permissions';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { PackageLoader } from '../src/loader/package-loader.js';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import { createPermissionManagerGate } from '../src/permissions/permission-manager-gate.js';
import { buildContractLawyerBundle, buildFraudDetectorBundle, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';
function baseRequest(overrides = {}) {
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
function fixedConsent(consent) {
    return { async requestConsent() { return consent; } };
}
// ===========================================================================
// Section 5 - permissionless vs. privileged-but-unregistered capabilities
// ===========================================================================
test('sec5: a capability with no manifest permission declaration executes freely (legitimately permissionless)', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle(); // no `permissions` field at all
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const gate = createPermissionManagerGate({ manager }); // no registry either - pure manifest resolution
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
        const result = await engine.execute(baseRequest({ capabilityId: 'clause_lookup' }));
        assert.equal(result.session.status, 'completed');
        assert.equal(provider.requests.length, 1);
    });
});
test('sec5: a capability with a declared permission requires it - no grant means DENIED, zero manual registration involved', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({
            permissions: [{ permission: 'filesystem.read', scope: '/workspace', capabilityId: 'contract_analysis' }],
        });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        // Deliberately no CapabilityPermissionRegistry, no `.register()` call
        // anywhere - the manifest declaration alone is what's enforced.
        const gate = createPermissionManagerGate({ manager });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
        const result = await engine.execute(baseRequest({ capabilityId: 'contract_analysis' }));
        assert.equal(result.session.status, 'failed');
        assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
        assert.equal(provider.requests.length, 0);
    });
});
test('sec5: a malformed manifest permission declaration is rejected at MOUNT time - fails closed before any execution is possible', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({
            permissions: [{ permission: 'not-a-real-permission', capabilityId: 'contract_analysis' }],
        });
        await installer.install(bundle);
        const loader = new PackageLoader(installer);
        const result = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.error.code, 'XO_RUNTIME_MOUNT_FAILED');
            assert.match(result.error.message, /malformed permission declaration/);
        }
    });
});
test('sec5: an unknown permission domain in a manifest declaration is also rejected at mount time', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({
            permissions: [{ permission: 'bogus_domain.action', capabilityId: 'contract_analysis' }],
        });
        await installer.install(bundle);
        const loader = new PackageLoader(installer);
        const result = await loader.mount(bundle.manifest.name, bundle.manifest.version, PackageRegistry.empty());
        assert.equal(result.ok, false);
    });
});
test('sec5: granting the declared permission allows the previously-denied capability to execute', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({
            permissions: [{ permission: 'filesystem.read', scope: '/workspace', capabilityId: 'contract_analysis' }],
        });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const gate = createPermissionManagerGate({ manager });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
        await manager.grant({ packageId: PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`), permission: Permissions.filesystem.read, scope: pathScope('/workspace') });
        const result = await engine.execute(baseRequest({ capabilityId: 'contract_analysis' }));
        assert.equal(result.session.status, 'completed');
        assert.equal(provider.requests.length, 1);
    });
});
// ===========================================================================
// Section 6 - auxiliary capabilities cannot bypass permission enforcement
// ===========================================================================
test('sec6: an auxiliary capability requiring an ungranted permission blocks the WHOLE request, even though the primary capability is permissionless', async () => {
    await withTempInstaller(async (installer) => {
        const contractBundle = buildContractLawyerBundle(); // clause_lookup: no permissions declared
        const fraudBundle = buildFraudDetectorBundle({
            permissions: [{ permission: 'data.read', scope: 'customer_records', capabilityId: 'fraud_detection' }],
        });
        await installer.install(contractBundle);
        await installer.install(fraudBundle);
        let registry = await mountBundle(installer, contractBundle);
        registry = await mountBundle(installer, fraudBundle, registry);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const gate = createPermissionManagerGate({ manager });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
        const result = await engine.execute(baseRequest({ capabilityId: 'clause_lookup', auxiliaryCapabilityIds: ['fraud_detection'] }));
        assert.equal(result.session.status, 'failed');
        assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
        assert.match(result.error?.message ?? '', /fraud_detection/);
        assert.equal(provider.requests.length, 0);
    });
});
test('sec6: an auxiliary capability with its OWN granted permission is allowed, and its data is merged as usual', async () => {
    await withTempInstaller(async (installer) => {
        const contractBundle = buildContractLawyerBundle();
        const fraudBundle = buildFraudDetectorBundle({
            permissions: [{ permission: 'data.read', scope: 'customer_records', capabilityId: 'fraud_detection' }],
        });
        await installer.install(contractBundle);
        await installer.install(fraudBundle);
        let registry = await mountBundle(installer, contractBundle);
        registry = await mountBundle(installer, fraudBundle, registry);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const gate = createPermissionManagerGate({ manager });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
        await manager.grant({ packageId: PackageId(`${fraudBundle.manifest.name}@${fraudBundle.manifest.version}`), permission: Permissions.data.read, scope: { kind: 'resource', resource: 'customer_records' } });
        const result = await engine.execute(baseRequest({ capabilityId: 'clause_lookup', auxiliaryCapabilityIds: ['fraud_detection'] }));
        assert.equal(result.session.status, 'completed');
        assert.equal(provider.requests.length, 1);
    });
});
test('sec6: an auxiliary capability id that does not resolve to any mounted package is silently skipped (not a security question, just unresolved data)', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle();
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const gate = createPermissionManagerGate({ manager });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: gate });
        const result = await engine.execute(baseRequest({ capabilityId: 'clause_lookup', auxiliaryCapabilityIds: ['does_not_exist'] }));
        assert.equal(result.session.status, 'completed');
    });
});
// ===========================================================================
// Section 8 - full manifest -> mount -> ExecutionEngine -> PermissionGate ->
// PermissionManager -> decision -> execution integration, cases A-G
// ===========================================================================
test('sec8 case A: manifest requires filesystem.read, no grant -> DENIED, component not executed', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({ permissions: [{ permission: 'filesystem.read', scope: '/workspace/project', capabilityId: 'contract_analysis' }] });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager }) });
        const result = await engine.execute(baseRequest());
        assert.equal(result.session.status, 'failed');
        assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
        assert.equal(provider.requests.length, 0);
    });
});
test('sec8 case B: valid grant for the correct scope -> ALLOWED, component executes', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({ permissions: [{ permission: 'filesystem.read', scope: '/workspace/project', capabilityId: 'contract_analysis' }] });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const packageId = PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`);
        await manager.grant({ packageId, permission: Permissions.filesystem.read, scope: pathScope('/workspace/project') });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager }) });
        const result = await engine.execute(baseRequest());
        assert.equal(result.session.status, 'completed');
        assert.equal(provider.requests.length, 1);
    });
});
test('sec8 case C: grant scoped to /workspace/project does not authorize a manifest requirement scoped to /workspace/secrets -> DENIED', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({ permissions: [{ permission: 'filesystem.read', scope: '/workspace/secrets', capabilityId: 'contract_analysis' }] });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const packageId = PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`);
        await manager.grant({ packageId, permission: Permissions.filesystem.read, scope: pathScope('/workspace/project') });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager }) });
        const result = await engine.execute(baseRequest());
        assert.equal(result.session.status, 'failed');
        assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    });
});
test('sec8 case D: revoke is reflected in actual Runtime execution - allowed, then denied after revoke', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({ permissions: [{ permission: 'filesystem.read', scope: '/workspace/project', capabilityId: 'contract_analysis' }] });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
        const packageId = PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`);
        await manager.grant({ packageId, permission: Permissions.filesystem.read, scope: pathScope('/workspace/project') });
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager }) });
        const allowed = await engine.execute(baseRequest({ requestId: RequestId('req_before_revoke') }));
        assert.equal(allowed.session.status, 'completed');
        await manager.revoke({ kind: 'package', packageId });
        const denied = await engine.execute(baseRequest({ requestId: RequestId('req_after_revoke') }));
        assert.equal(denied.session.status, 'failed');
        assert.equal(denied.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    });
});
test('sec8 case E: consent narrowing - requested /workspace, consent narrows to /workspace/project -> only /workspace/project is granted', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({ permissions: [{ permission: 'filesystem.read', scope: '/workspace/project', capabilityId: 'contract_analysis' }] });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const policy = new RuleBasedPolicy([{ id: 'prompt-fs-read', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
        const store = new InMemoryPermissionStore();
        const manager = new PermissionManager({ policy, store, consentProvider: fixedConsent({ granted: true, lifetime: 'persistent', scope: pathScope('/workspace/project') }) });
        const packageId = PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`);
        const consentDecision = await manager.request({ permission: Permissions.filesystem.read, scope: pathScope('/workspace'), requester: { packageId, capabilityId: 'contract_analysis' } });
        assert.equal(consentDecision.effect, 'allow');
        assert.deepEqual(consentDecision.grantedScope, pathScope('/workspace/project'));
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager }) });
        const result = await engine.execute(baseRequest());
        assert.equal(result.session.status, 'completed');
    });
});
test('sec8 case F: consent widening attempt - requested /workspace/project, consent /workspace -> rejected, no widened grant exists, execution still denied', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({ permissions: [{ permission: 'filesystem.read', scope: '/workspace/project', capabilityId: 'contract_analysis' }] });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const policy = new RuleBasedPolicy([{ id: 'prompt-fs-read', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
        const store = new InMemoryPermissionStore();
        const manager = new PermissionManager({ policy, store, consentProvider: fixedConsent({ granted: true, lifetime: 'persistent', scope: pathScope('/workspace') }) });
        const packageId = PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`);
        const consentDecision = await manager.request({ permission: Permissions.filesystem.read, scope: pathScope('/workspace/project'), requester: { packageId, capabilityId: 'contract_analysis' } });
        assert.equal(consentDecision.effect, 'deny');
        assert.equal(store.size(), 0);
        const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager }) });
        const result = await engine.execute(baseRequest());
        assert.equal(result.session.status, 'failed');
        assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    });
});
test('sec8 case G: an explicit policy DENY overrides a stored ALLOW grant -> DENIED', async () => {
    await withTempInstaller(async (installer) => {
        const bundle = buildContractLawyerBundle({ permissions: [{ permission: 'filesystem.read', scope: '/workspace/project', capabilityId: 'contract_analysis' }] });
        await installer.install(bundle);
        const registry = await mountBundle(installer, bundle);
        const provider = new ScriptedModelProvider();
        provider.setResponse({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });
        const packageId = PackageId(`${bundle.manifest.name}@${bundle.manifest.version}`);
        const store = new InMemoryPermissionStore();
        const manager = new PermissionManager({ policy: new RuleBasedPolicy([]), store });
        await manager.grant({ packageId, permission: Permissions.filesystem.read, scope: pathScope('/workspace/project') });
        const engineBefore = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager }) });
        const before = await engineBefore.execute(baseRequest({ requestId: RequestId('req_before_policy') }));
        assert.equal(before.session.status, 'completed');
        // Same store (same underlying grant, still present), new manager with
        // an emergency policy DENY layered on top - proves the DENY overrides
        // the grant rather than the grant simply having been removed.
        const managerWithEmergencyDeny = new PermissionManager({
            policy: new RuleBasedPolicy([{ id: 'emergency-deny-fs-read', effect: 'DENY', match: { permission: Permissions.filesystem.read } }]),
            store,
        });
        const engineAfter = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { permissionGate: createPermissionManagerGate({ manager: managerWithEmergencyDeny }) });
        const after = await engineAfter.execute(baseRequest({ requestId: RequestId('req_after_policy') }));
        assert.equal(after.session.status, 'failed');
        assert.equal(after.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
        const stillThere = await store.list({ packageId, permission: Permissions.filesystem.read });
        assert.equal(stillThere.ok, true);
        if (stillThere.ok)
            assert.equal(stillThere.value.length, 1); // the grant itself was never touched
    });
});
//# sourceMappingURL=permission-integration.test.js.map