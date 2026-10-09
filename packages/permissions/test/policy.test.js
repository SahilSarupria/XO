import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import { Permissions } from '../src/permission-id.js';
import { globalScope, pathScope } from '../src/scope.js';
import { RuleBasedPolicy, decisionFromPolicyVerdict } from '../src/policy.js';
const pkg = PackageId('acme.widgets');
const now = () => new Date('2026-01-01T00:00:00.000Z');
function request(overrides = {}) {
    return {
        permission: Permissions.filesystem.read,
        requester: { packageId: pkg },
        ...overrides,
    };
}
test('policy: default is deny when nothing matches', () => {
    const policy = new RuleBasedPolicy([]);
    const verdict = policy.evaluate(request());
    assert.equal(verdict.effect, 'NO_MATCH');
    const decision = decisionFromPolicyVerdict(request(), verdict, policy.getDefaultEffect(), now);
    assert.equal(decision.effect, 'deny');
});
test('policy: an unscoped ALLOW rule allows an unscoped request', () => {
    const policy = new RuleBasedPolicy([{ id: 'allow-fs-read', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } }]);
    const verdict = policy.evaluate(request());
    assert.equal(verdict.effect, 'ALLOW');
    assert.equal(verdict.ruleId, 'allow-fs-read');
});
test('policy: PROMPT effect surfaces as a prompt decision', () => {
    const policy = new RuleBasedPolicy([{ id: 'prompt-fs-read', effect: 'PROMPT', match: { permission: Permissions.filesystem.read } }]);
    const decision = decisionFromPolicyVerdict(request(), policy.evaluate(request()), policy.getDefaultEffect(), now);
    assert.equal(decision.effect, 'prompt');
});
test('policy precedence: a scoped ALLOW overrides a broader (global) DENY — §14 worked example', () => {
    const rules = [
        { id: 'deny-fs-read-global', effect: 'DENY', match: { permission: Permissions.filesystem.read, scope: globalScope() } },
        { id: 'allow-fs-read-workspace', effect: 'ALLOW', match: { permission: Permissions.filesystem.read, scope: pathScope('/workspace/project') } },
    ];
    const policy = new RuleBasedPolicy(rules);
    const scopedRequest = request({ scope: pathScope('/workspace/project') });
    const scopedVerdict = policy.evaluate(scopedRequest);
    assert.equal(scopedVerdict.effect, 'ALLOW');
    assert.equal(scopedVerdict.ruleId, 'allow-fs-read-workspace');
    // A request for a *different, unrelated* path still falls to the
    // broader deny — the scoped allow does not leak outside its own scope.
    const otherRequest = request({ scope: pathScope('/etc') });
    const otherVerdict = policy.evaluate(otherRequest);
    assert.equal(otherVerdict.effect, 'DENY');
});
test('policy precedence: among equally specific rules, DENY wins over ALLOW (fail-safe tiebreak)', () => {
    const rules = [
        { id: 'allow-exact', effect: 'ALLOW', match: { permission: Permissions.filesystem.read, scope: pathScope('/workspace/project') } },
        { id: 'deny-exact', effect: 'DENY', match: { permission: Permissions.filesystem.read, scope: pathScope('/workspace/project') } },
    ];
    const policy = new RuleBasedPolicy(rules);
    const verdict = policy.evaluate(request({ scope: pathScope('/workspace/project') }));
    assert.equal(verdict.effect, 'DENY');
    assert.equal(verdict.ruleId, 'deny-exact');
});
test('policy precedence: exact permission match beats domain-only match', () => {
    const rules = [
        { id: 'domain-deny', effect: 'DENY', match: { domain: 'filesystem' } },
        { id: 'permission-allow', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } },
    ];
    const policy = new RuleBasedPolicy(rules);
    const verdict = policy.evaluate(request());
    assert.equal(verdict.effect, 'ALLOW');
    assert.equal(verdict.ruleId, 'permission-allow');
});
test('policy precedence: package-scoped rule beats a rule with no package match', () => {
    const otherPkg = PackageId('other.package');
    const rules = [
        { id: 'deny-all', effect: 'DENY', match: { permission: Permissions.network.connect } },
        { id: 'allow-this-package', effect: 'ALLOW', match: { permission: Permissions.network.connect, packageId: pkg } },
    ];
    const policy = new RuleBasedPolicy(rules);
    assert.equal(policy.evaluate(request({ permission: Permissions.network.connect, requester: { packageId: pkg } })).ruleId, 'allow-this-package');
    assert.equal(policy.evaluate(request({ permission: Permissions.network.connect, requester: { packageId: otherPkg } })).ruleId, 'deny-all');
});
test('policy: environment dimension restricts a rule to matching context', () => {
    const rules = [{ id: 'allow-dev-only', effect: 'ALLOW', match: { permission: Permissions.secrets.read, environment: 'development' } }];
    const policy = new RuleBasedPolicy(rules);
    assert.equal(policy.evaluate(request({ permission: Permissions.secrets.read, context: { environment: 'development' } })).effect, 'ALLOW');
    assert.equal(policy.evaluate(request({ permission: Permissions.secrets.read, context: { environment: 'production' } })).effect, 'NO_MATCH');
    assert.equal(policy.evaluate(request({ permission: Permissions.secrets.read })).effect, 'NO_MATCH');
});
test('policy: determinism — identical request and policy state always produce the identical verdict', () => {
    const rules = [
        { id: 'deny-global', effect: 'DENY', match: { permission: Permissions.filesystem.read } },
        { id: 'allow-scoped', effect: 'ALLOW', match: { permission: Permissions.filesystem.read, scope: pathScope('/workspace') } },
    ];
    const policy = new RuleBasedPolicy(rules);
    const req = request({ scope: pathScope('/workspace/app') });
    const first = policy.evaluate(req);
    for (let i = 0; i < 25; i += 1) {
        const again = policy.evaluate(req);
        assert.deepEqual(again, first);
    }
});
test('policy: withRule/withRules do not mutate the original policy', () => {
    const base = new RuleBasedPolicy([{ id: 'r1', effect: 'ALLOW', match: { permission: Permissions.filesystem.read } }]);
    const extended = base.withRule({ id: 'r2', effect: 'DENY', match: { permission: Permissions.network.connect } });
    assert.equal(base.getRules().length, 1);
    assert.equal(extended.getRules().length, 2);
});
//# sourceMappingURL=policy.test.js.map