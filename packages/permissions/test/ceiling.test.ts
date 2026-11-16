// UW-1 (ADR 0010): the `role` match dimension and the domain ceiling that make one PermissionManager the single authorization point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PackageId } from '@xo/types';
import { Permissions } from '../src/permission-id.js';
import { RuleBasedPolicy, type PolicyRule } from '../src/policy.js';
import { DomainCeilingPolicy } from '../src/ceiling.js';
import { PermissionManager } from '../src/manager.js';
import { InMemoryPermissionStore } from '../src/store.js';
import type { PermissionRequest } from '../src/request.js';
import type { PermissionGrant } from '../src/grant.js';
import { globalScope } from '../src/scope.js';

const requester = { packageId: PackageId('xo.api'), capabilityId: 'workspace' };
const human = { kind: 'human' as const, id: 'alice' };

function req(permission: PermissionRequest['permission'], role?: string): PermissionRequest {
  return { permission, requester, principal: human, ...(role !== undefined ? { context: { role } } : {}) };
}

const ceilingRules: PolicyRule[] = [
  { id: 'role.admin.author', effect: 'ALLOW', match: { permission: Permissions.workspace.author, role: 'admin' } },
  { id: 'role.viewer.read', effect: 'ALLOW', match: { permission: Permissions.workspace.read, role: 'viewer' } },
];

test('role dimension: a rule with `role` matches only the same server-supplied context.role', () => {
  const policy = new RuleBasedPolicy(ceilingRules);
  assert.equal(policy.evaluate(req(Permissions.workspace.author, 'admin')).effect, 'ALLOW');
  assert.equal(policy.evaluate(req(Permissions.workspace.author, 'viewer')).effect, 'NO_MATCH');
  assert.equal(policy.evaluate(req(Permissions.workspace.author)).effect, 'NO_MATCH', 'no role in context never matches a role rule');
});

test('role dimension: a role rule is more specific than a permission-only rule', () => {
  const policy = new RuleBasedPolicy([
    { id: 'deny-all-author', effect: 'DENY', match: { permission: Permissions.workspace.author } },
    { id: 'admin-author', effect: 'ALLOW', match: { permission: Permissions.workspace.author, role: 'admin' } },
  ]);
  assert.equal(policy.evaluate(req(Permissions.workspace.author, 'admin')).ruleId, 'admin-author');
});

function ceiling(inner: RuleBasedPolicy | { evaluate: RuleBasedPolicy['evaluate'] } = new RuleBasedPolicy([])) {
  return new DomainCeilingPolicy({ domain: 'workspace', ceiling: new RuleBasedPolicy(ceilingRules), inner });
}

test('ceiling: inside the domain, only what the ceiling allows is allowed; everything else is an explicit DENY', () => {
  const policy = ceiling();
  assert.equal(policy.evaluate(req(Permissions.workspace.author, 'admin')).effect, 'ALLOW');
  const refused = policy.evaluate(req(Permissions.workspace.author, 'viewer'));
  assert.equal(refused.effect, 'DENY', 'outside the ceiling is DENY, not NO_MATCH, so a stored grant cannot widen it');
  assert.equal(policy.evaluate(req(Permissions.workspace.manage)).effect, 'DENY', 'no role at all is denied');
});

test('ceiling: an operator ALLOW (even allow-all) never widens the ceiling', () => {
  const policy = ceiling(new RuleBasedPolicy([{ id: 'all', effect: 'ALLOW', match: {} }]));
  assert.equal(policy.evaluate(req(Permissions.workspace.author, 'viewer')).effect, 'DENY');
  assert.equal(policy.evaluate(req(Permissions.workspace.read, 'viewer')).effect, 'ALLOW');
});

test('ceiling: an operator explicit DENY narrows the ceiling (suspend one principal at once)', () => {
  const policy = ceiling(
    new RuleBasedPolicy([{ id: 'suspend-alice', effect: 'DENY', match: { domain: 'workspace', principalId: 'alice' } }]),
  );
  const v = policy.evaluate(req(Permissions.workspace.author, 'admin'));
  assert.equal(v.effect, 'DENY');
  assert.equal(v.ruleId, 'suspend-alice');
});

test('ceiling: outside the domain the inner policy decides, unchanged', () => {
  const inner = new RuleBasedPolicy([
    { id: 'proc', effect: 'ALLOW', match: { permission: Permissions.procedure.execute, principalId: 'alice' } },
  ]);
  const policy = ceiling(inner);
  assert.deepEqual(policy.evaluate(req(Permissions.procedure.execute)), inner.evaluate(req(Permissions.procedure.execute)));
  assert.equal(policy.evaluate(req(Permissions.procedure.approve)).effect, 'NO_MATCH');
});

test('ceiling through PermissionManager: a stored grant cannot widen the ceiling; an exception propagates (callers fail closed)', async () => {
  const grant: PermissionGrant = {
    id: 'g1',
    permission: Permissions.workspace.author,
    scope: globalScope(),
    packageId: requester.packageId,
    lifetime: 'persistent',
    consentInvolved: false,
    grantedAt: '2026-01-01T00:00:00.000Z',
  };
  const store = new InMemoryPermissionStore();
  assert.ok((await store.set(grant)).ok);
  // Control: without a ceiling, the same stored grant DOES authorize (policy NO_MATCH lets the grant stand).
  const uncapped = new PermissionManager({ policy: new RuleBasedPolicy([]), store });
  assert.equal((await uncapped.check(req(Permissions.workspace.author, 'viewer'))).effect, 'allow');
  const manager = new PermissionManager({ policy: ceiling(), store });
  assert.equal((await manager.check(req(Permissions.workspace.author, 'viewer'))).effect, 'deny');
  assert.equal((await manager.check(req(Permissions.workspace.author, 'admin'))).effect, 'allow');

  const throwing = new PermissionManager({
    policy: ceiling({
      evaluate: () => {
        throw new Error('policy engine down');
      },
    }),
  });
  await assert.rejects(() => throwing.check(req(Permissions.workspace.read, 'viewer')));
});
