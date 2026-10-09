import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt } from '../src/session/execution-receipt.js';
import { createSession, withPlan, withReceipt } from '../src/session/execution-session.js';
import { CapabilityNegotiator } from '../src/capability/capability-negotiator.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { PackageRegistry } from '../src/registry/mounted-package.js';
import { MountId, RequestId, EnvironmentId } from '../src/ids.js';
import { contractAnalysisCapability, contractCompatibility } from './fixtures.js';
function mount() {
    return Object.freeze({
        mountId: MountId('xo_lawyer@1.0.0#0'),
        name: 'xo_lawyer',
        version: '1.0.0',
        manifest: {
            formatVersion: '1.0',
            name: 'xo_lawyer',
            version: '1.0.0',
            creatorDid: 'did:xo:test',
            compatibility: contractCompatibility,
            components: {
                knowledge_graph: { path: 'knowledge/graph.json', hash: 'sha256:' + 'a'.repeat(64), required: false },
                safety_rules: { path: 'safety/rules.json', hash: 'sha256:' + 'c'.repeat(64), required: true },
            },
            capabilities: [contractAnalysisCapability],
        },
        capabilities: [{ declaration: contractAnalysisCapability, packageName: 'xo_lawyer', packageVersion: '1.0.0' }],
        mountedAt: '2026-01-01T00:00:00.000Z',
        manifestHash: 'sha256:fake',
    });
}
function baseRequest() {
    return {
        requestId: RequestId('req_1'),
        capabilityId: 'contract_analysis',
        environment: {
            environmentId: EnvironmentId('env_1'),
            hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
            provider: 'anthropic',
            tokenBudget: 10_000,
            createdAt: '2026-01-01T00:00:00.000Z',
        },
        requestedAt: '2026-01-01T00:00:00.000Z',
    };
}
test('buildReceipt() captures the selected plan candidate\'s package and component hashes', () => {
    const registry = PackageRegistry.empty().withMounted(mount());
    const context = buildRuntimeContext(registry);
    const plan = new CapabilityNegotiator().plan(baseRequest(), context);
    const receipt = buildReceipt({
        plan,
        registry,
        validationResults: { valid: true, issues: [] },
        executionDurationMs: 42,
        environment: baseRequest().environment,
    });
    assert.equal(receipt.packagesUsed.length, 1);
    assert.equal(receipt.packagesUsed[0]?.name, 'xo_lawyer');
    assert.equal(receipt.componentHashes.length, 2);
    assert.deepEqual(receipt.capabilitiesInvoked, ['contract_analysis']);
    assert.equal(receipt.provider, 'anthropic');
    assert.deepEqual(receipt.tokenUsage, { promptTokens: 0, completionTokens: 0 });
    assert.equal(receipt.executionDurationMs, 42);
});
test('buildReceipt() for a plan with no selected candidate still produces a valid, empty-handed receipt', () => {
    const registry = PackageRegistry.empty();
    const context = buildRuntimeContext(registry);
    const plan = new CapabilityNegotiator().plan(baseRequest(), context);
    const receipt = buildReceipt({ plan, registry, validationResults: { valid: false, issues: [] }, executionDurationMs: 5 });
    assert.deepEqual(receipt.packagesUsed, []);
    assert.deepEqual(receipt.componentHashes, []);
    assert.deepEqual(receipt.capabilitiesInvoked, []);
});
test('a receipt is frozen (immutable) and JSON-serializable', () => {
    const registry = PackageRegistry.empty().withMounted(mount());
    const context = buildRuntimeContext(registry);
    const plan = new CapabilityNegotiator().plan(baseRequest(), context);
    const receipt = buildReceipt({ plan, registry, validationResults: { valid: true, issues: [] }, executionDurationMs: 1 });
    assert.ok(Object.isFrozen(receipt));
    const roundTripped = JSON.parse(JSON.stringify(receipt));
    assert.deepEqual(roundTripped.packagesUsed, receipt.packagesUsed);
});
test('createSession() starts pending, carries the environment\'s tokenBudget/provider', () => {
    const session = createSession(baseRequest(), () => new Date('2026-01-01T00:00:00.000Z'));
    assert.equal(session.status, 'pending');
    assert.equal(session.tokenBudget, 10_000);
    assert.equal(session.provider, 'anthropic');
    assert.deepEqual(session.receipts, []);
});
test('withPlan() moves the session to "planned" when the plan has a selected candidate, "plan_failed" otherwise', () => {
    const registry = PackageRegistry.empty().withMounted(mount());
    const context = buildRuntimeContext(registry);
    const plan = new CapabilityNegotiator().plan(baseRequest(), context);
    const session = createSession(baseRequest());
    const planned = withPlan(session, plan);
    assert.equal(planned.status, 'planned');
    assert.deepEqual(planned.chosenCapabilities, ['contract_analysis']);
    assert.equal(session.status, 'pending', 'original session must not be mutated');
    const emptyContext = buildRuntimeContext(PackageRegistry.empty());
    const failedPlan = new CapabilityNegotiator().plan(baseRequest(), emptyContext);
    const failed = withPlan(createSession(baseRequest()), failedPlan);
    assert.equal(failed.status, 'plan_failed');
});
test('withReceipt() appends a receipt and moves the session to "completed"', () => {
    const registry = PackageRegistry.empty().withMounted(mount());
    const context = buildRuntimeContext(registry);
    const plan = new CapabilityNegotiator().plan(baseRequest(), context);
    const receipt = buildReceipt({ plan, registry, validationResults: { valid: true, issues: [] }, executionDurationMs: 1 });
    const session = withReceipt(createSession(baseRequest()), receipt);
    assert.equal(session.status, 'completed');
    assert.equal(session.receipts.length, 1);
});
test('a session is frozen (immutable) at every stage', () => {
    const session = createSession(baseRequest());
    assert.ok(Object.isFrozen(session));
});
//# sourceMappingURL=execution-session.test.js.map