import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import { MockClock } from '@xo/testing';
import { Permissions } from '../src/permission-id.js';
import { globalScope, hostScope, pathScope } from '../src/scope.js';
import { RuleBasedPolicy } from '../src/policy.js';
import { InMemoryPermissionStore } from '../src/store.js';
import { InMemoryAuditSink } from '../src/audit.js';
import { PermissionManager } from '../src/manager.js';
const pkgA = PackageId('acme.widgets');
const pkgB = PackageId('acme.gadgets');
function makeRequest(overrides = {}) {
    return {
        permission: Permissions.filesystem.read,
        requester: { packageId: pkgA },
        ...overrides,
    };
}
function fixedConsentProvider(consent) {
    return { async requestConsent() { return consent; } };
}
test('manager.check: default-deny when no policy rule and no grant exist', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.policyId, 'system.default-policy');
});
test('manager.check: never triggers consent, even when policy says PROMPT', async () => {
    let called = false;
    const consentProvider = {
        async requestConsent() {
            called = true;
            return { granted: true };
        },
    };
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy, consentProvider });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'prompt');
    assert.equal(called, false);
});
test('manager.request: with no consent provider, a PROMPT policy stays unresolved (never silently allows)', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy });
    const decision = await manager.request(makeRequest());
    assert.equal(decision.effect, 'prompt');
});
test('manager.request: consent granted (once) allows this request but is not persisted', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const store = new InMemoryPermissionStore();
    const manager = new PermissionManager({ policy, store, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'once' }) });
    const decision = await manager.request(makeRequest());
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.lifetime, 'once');
    assert.equal(decision.persistent, false);
    assert.equal(store.size(), 0);
    // Because it was "once", a subsequent check must prompt again.
    const second = await manager.check(makeRequest());
    assert.equal(second.effect, 'prompt');
});
test('manager.request: consent granted (persistent) is stored and honored by future check()', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const store = new InMemoryPermissionStore();
    const manager = new PermissionManager({ policy, store, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'persistent', scope: pathScope('/workspace') }) });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.persistent, true);
    assert.equal(store.size(), 1);
    const second = await manager.check(makeRequest({ scope: pathScope('/workspace/subdir') }));
    assert.equal(second.effect, 'allow');
    assert.equal(second.policyId, 'store.grant');
});
test('manager.request: consent narrowing a scope is honored, never widened beyond the request', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({
        policy,
        consentProvider: fixedConsentProvider({ granted: true, lifetime: 'once', scope: pathScope('/workspace/project') }),
    });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'allow');
    assert.deepEqual(decision.grantedScope, pathScope('/workspace/project'));
});
test('manager.request: consent declined denies deterministically', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy, consentProvider: fixedConsentProvider({ granted: false, reason: 'no thanks' }) });
    const decision = await manager.request(makeRequest());
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.consentInvolved, true);
});
test('manager.grant / list / revoke: admin lifecycle', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    const granted = await manager.grant({ packageId: pkgA, permission: Permissions.network.connect });
    assert.equal(granted.ok, true);
    const listed = await manager.list({ packageId: pkgA });
    assert.equal(listed.ok, true);
    if (listed.ok)
        assert.equal(listed.value.length, 1);
    const check = await manager.check(makeRequest({ permission: Permissions.network.connect }));
    assert.equal(check.effect, 'allow');
    const revoked = await manager.revoke({ kind: 'permission', packageId: pkgA, permission: Permissions.network.connect });
    assert.equal(revoked.ok, true);
    if (revoked.ok)
        assert.equal(revoked.value, 1);
    const checkAfterRevoke = await manager.check(makeRequest({ permission: Permissions.network.connect }));
    assert.equal(checkAfterRevoke.effect, 'deny');
});
test('manager.revoke: revoking one permission does not affect a different permission for the same package', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    await manager.grant({ packageId: pkgA, permission: Permissions.network.connect });
    await manager.revoke({ kind: 'permission', packageId: pkgA, permission: Permissions.filesystem.read });
    assert.equal((await manager.check(makeRequest({ permission: Permissions.filesystem.read }))).effect, 'deny');
    assert.equal((await manager.check(makeRequest({ permission: Permissions.network.connect }))).effect, 'allow');
});
test('manager.revoke: "package" kind revokes every grant for that package only', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    await manager.grant({ packageId: pkgA, permission: Permissions.network.connect });
    await manager.grant({ packageId: pkgB, permission: Permissions.filesystem.read });
    const revoked = await manager.revoke({ kind: 'package', packageId: pkgA });
    assert.equal(revoked.ok, true);
    if (revoked.ok)
        assert.equal(revoked.value, 2);
    assert.equal((await manager.check(makeRequest({ permission: Permissions.filesystem.read, requester: { packageId: pkgA } }))).effect, 'deny');
    assert.equal((await manager.check(makeRequest({ permission: Permissions.filesystem.read, requester: { packageId: pkgB } }))).effect, 'allow');
});
test('manager.revoke: "capability" kind revokes only grants attributed to that capability', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read, requesterCapabilityId: 'financial.document.read' });
    await manager.grant({ packageId: pkgA, permission: Permissions.network.connect, requesterCapabilityId: 'web.research' });
    const revoked = await manager.revoke({ kind: 'capability', packageId: pkgA, capabilityId: 'financial.document.read' });
    assert.equal(revoked.ok, true);
    if (revoked.ok)
        assert.equal(revoked.value, 1);
    assert.equal((await manager.check(makeRequest({ permission: Permissions.filesystem.read }))).effect, 'deny');
    assert.equal((await manager.check(makeRequest({ permission: Permissions.network.connect }))).effect, 'allow');
});
test('manager.revoke: "all" wipes every package', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    await manager.grant({ packageId: pkgB, permission: Permissions.filesystem.read });
    const revoked = await manager.revoke({ kind: 'all' });
    assert.equal(revoked.ok, true);
    if (revoked.ok)
        assert.equal(revoked.value, 2);
});
test('lifetimes: session grants disappear after endSession(), persistent grants survive it', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read, lifetime: 'session' });
    await manager.grant({ packageId: pkgA, permission: Permissions.network.connect, lifetime: 'persistent' });
    assert.equal((await manager.check(makeRequest({ permission: Permissions.filesystem.read }))).effect, 'allow');
    assert.equal((await manager.check(makeRequest({ permission: Permissions.network.connect }))).effect, 'allow');
    const ended = await manager.endSession();
    assert.equal(ended.ok, true);
    if (ended.ok)
        assert.equal(ended.value, 1);
    assert.equal((await manager.check(makeRequest({ permission: Permissions.filesystem.read }))).effect, 'deny');
    assert.equal((await manager.check(makeRequest({ permission: Permissions.network.connect }))).effect, 'allow');
});
test('package isolation: package A grants never leak into package B checks', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.secrets.read });
    const forA = await manager.check(makeRequest({ permission: Permissions.secrets.read, requester: { packageId: pkgA } }));
    const forB = await manager.check(makeRequest({ permission: Permissions.secrets.read, requester: { packageId: pkgB } }));
    assert.equal(forA.effect, 'allow');
    assert.equal(forB.effect, 'deny');
});
test('failure behavior: a malformed permission id fails closed to deny, never throws', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    const decision = await manager.check(makeRequest({ permission: 'not a real permission' }));
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.policyId, 'system.fail-closed');
});
test('audit: every state transition emits the correct event type', async () => {
    const audit = new InMemoryAuditSink();
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy, auditSink: audit, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'persistent' }) });
    await manager.request(makeRequest());
    const types = audit.all().map((e) => e.type);
    assert.deepEqual(types, ['permission.requested', 'permission.prompted', 'permission.granted', 'permission.allowed']);
});
test('audit: a denied check emits requested + denied', async () => {
    const audit = new InMemoryAuditSink();
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]), auditSink: audit });
    await manager.check(makeRequest());
    assert.deepEqual(audit.all().map((e) => e.type), ['permission.requested', 'permission.denied']);
});
test('audit: revocation emits permission.revoked', async () => {
    const audit = new InMemoryAuditSink();
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]), auditSink: audit });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    audit.all(); // grant already recorded 'permission.granted'
    await manager.revoke({ kind: 'package', packageId: pkgA });
    assert.ok(audit.ofType('permission.revoked').length === 1);
});
test('manager uses the injected clock for decision timestamps', async () => {
    const clock = new MockClock('2030-05-01T00:00:00.000Z');
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]), clock });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.decidedAt, '2030-05-01T00:00:00.000Z');
});
test('store failure fails closed to deny rather than throwing', async () => {
    const failingStore = {
        async get() { return { ok: false, error: new (await import('@xo/errors')).PermissionError((await import('@xo/errors')).ErrorCode.PERMISSION_STORE_ERROR, 'boom') }; },
        async set() { return { ok: false, error: new (await import('@xo/errors')).PermissionError((await import('@xo/errors')).ErrorCode.PERMISSION_STORE_ERROR, 'boom') }; },
        async delete() { return { ok: false, error: new (await import('@xo/errors')).PermissionError((await import('@xo/errors')).ErrorCode.PERMISSION_STORE_ERROR, 'boom') }; },
        async list() { return { ok: false, error: new (await import('@xo/errors')).PermissionError((await import('@xo/errors')).ErrorCode.PERMISSION_STORE_ERROR, 'boom') }; },
    };
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'allow-all', effect: 'ALLOW', match: {} }]), store: failingStore });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.policyId, 'system.fail-closed');
});
// --- Consent scope escalation (Stage 2, §2) -------------------------------
// "Consent may narrow a requested scope, but must never widen it" is
// enforced, not just documented — see manager.ts's request() and
// scope.ts's scopeWithinRequest/isPermissionScope.
test('consent scope: exact same scope as requested is valid', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const store = new InMemoryPermissionStore();
    const manager = new PermissionManager({ policy, store, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'persistent', scope: pathScope('/workspace') }) });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'allow');
    assert.deepEqual(decision.grantedScope, pathScope('/workspace'));
});
test('consent scope: a narrower child scope is valid (§2 example 1: requested /workspace, consent /workspace/project)', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'once', scope: pathScope('/workspace/project') }) });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'allow');
    assert.deepEqual(decision.grantedScope, pathScope('/workspace/project'));
});
test('consent scope: a wider parent scope is INVALID and fails closed (§2 example 2: requested /workspace/project, consent /workspace)', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const store = new InMemoryPermissionStore();
    const manager = new PermissionManager({ policy, store, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'persistent', scope: pathScope('/workspace') }) });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace/project') }));
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.policyId, 'system.fail-closed');
    assert.equal(store.size(), 0); // no widened grant was ever persisted
});
test('consent scope: an unrelated scope (different value, same kind) is INVALID', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'once', scope: pathScope('/etc') }) });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'deny');
});
test('consent scope: an unrelated scope of a DIFFERENT kind is INVALID', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.network.connect } }]);
    const manager = new PermissionManager({ policy, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'once', scope: hostScope('api.example.com') }) });
    const decision = await manager.request(makeRequest({ permission: Permissions.network.connect, scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'deny');
});
test('consent scope: an unscoped (global) request accepts any consent-narrowed scope', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'once', scope: pathScope('/workspace') }) });
    const decision = await manager.request(makeRequest()); // no request.scope
    assert.equal(decision.effect, 'allow');
    assert.deepEqual(decision.grantedScope, pathScope('/workspace'));
});
test('consent scope: consent with no scope at all falls back to the request scope (or global) unchanged', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const manager = new PermissionManager({ policy, consentProvider: fixedConsentProvider({ granted: true, lifetime: 'once' }) });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'allow');
    assert.deepEqual(decision.grantedScope, pathScope('/workspace'));
    const unscoped = await manager.request(makeRequest());
    assert.equal(unscoped.effect, 'allow');
    assert.deepEqual(unscoped.grantedScope, globalScope());
});
test('consent scope: a malformed consent.scope object fails closed rather than being trusted', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const store = new InMemoryPermissionStore();
    const malformedConsentProvider = {
        async requestConsent() {
            return { granted: true, lifetime: 'persistent', scope: { kind: 'path', path: 42 } };
        },
    };
    const manager = new PermissionManager({ policy, store, consentProvider: malformedConsentProvider });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'deny');
    assert.equal(store.size(), 0);
});
test('consent scope: an entirely unrecognized scope shape fails closed', async () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-rule', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const bogusConsentProvider = {
        async requestConsent() {
            return { granted: true, lifetime: 'once', scope: { kind: 'wat' } };
        },
    };
    const manager = new PermissionManager({ policy, consentProvider: bogusConsentProvider });
    const decision = await manager.request(makeRequest({ scope: pathScope('/workspace') }));
    assert.equal(decision.effect, 'deny');
});
// --- Stored grant vs. policy precedence (Stage 2, §3) ----------------------
// Documented, deterministic precedence: an EXPLICIT matching policy DENY
// overrides a stored grant (emergency revocation via policy); a policy
// ALLOW or NO_MATCH never overrides an existing grant.
test('precedence: stored grant = ALLOW, explicit policy = DENY -> DENIED (policy wins, emergency override)', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'emergency-deny', effect: 'DENY', match: { permission: Permissions.filesystem.read } }]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.policyId, 'emergency-deny');
});
test('precedence: stored grant = ALLOW, explicit policy = ALLOW -> ALLOWED', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'explicit-allow', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } }]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'allow');
});
test('precedence: stored grant = ALLOW, no matching policy rule (NO_MATCH / default-deny) -> ALLOWED (grant is honored)', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) }); // default effect DENY, nothing matches
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.policyId, 'store.grant');
});
test('precedence: grant revoked, policy = ALLOW -> still ALLOWED via policy', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'explicit-allow', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } }]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    await manager.revoke({ kind: 'package', packageId: pkgA });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'allow');
    assert.equal(decision.policyId, 'explicit-allow');
});
test('precedence: no grant, no policy rule -> default-deny (unchanged baseline)', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([]) });
    const decision = await manager.check(makeRequest());
    assert.equal(decision.effect, 'deny');
    assert.equal(decision.policyId, 'system.default-policy');
});
test('precedence: an explicit DENY that does NOT match this request does not suppress an unrelated grant', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'deny-network', effect: 'DENY', match: { permission: Permissions.network.connect } }]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    const decision = await manager.check(makeRequest({ permission: Permissions.filesystem.read }));
    assert.equal(decision.effect, 'allow');
});
test('precedence: a scoped policy DENY overrides a broader grant for the same scope, but not a grant outside its scope', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'deny-secrets', effect: 'DENY', match: { permission: Permissions.filesystem.read, scope: pathScope('/workspace/secrets') } }]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read, scope: pathScope('/workspace') });
    const secretsRequest = await manager.check(makeRequest({ scope: pathScope('/workspace/secrets') }));
    assert.equal(secretsRequest.effect, 'deny');
    const otherRequest = await manager.check(makeRequest({ scope: pathScope('/workspace/public') }));
    assert.equal(otherRequest.effect, 'allow');
});
test('precedence: determinism — repeated evaluation of the same (grant, policy) state always yields the same result', async () => {
    const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'deny-all', effect: 'DENY', match: { permission: Permissions.filesystem.read } }]) });
    await manager.grant({ packageId: pkgA, permission: Permissions.filesystem.read });
    const first = await manager.check(makeRequest());
    for (let i = 0; i < 10; i += 1) {
        const again = await manager.check(makeRequest());
        assert.equal(again.effect, first.effect);
        assert.equal(again.policyId, first.policyId);
    }
});
//# sourceMappingURL=manager.test.js.map