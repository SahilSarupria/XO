// UW-1 (ADR 0010): every workspace route asks the instance's one PermissionManager; the role table is a ceiling that operator policy
// can only narrow. These tests prove (1) no answer changed, (2) operator policy cannot widen a role, (3) operator policy can narrow it,
// (4) the routes really go through the shared manager, (5) failures deny.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionManager, RuleBasedPolicy, type PermissionPolicy } from '@xo/permissions';
import { TestServer, withTempDir } from './test-helpers.js';
import { createAuthorizationPolicy, isWorkspaceAllowed, workspaceRoleRules } from '../src/workspace/authorizer.js';
import { roleAllows, type WorkspacePermission } from '../src/workspace/permissions.js';
import { WORKSPACE_ROLES, type WorkspaceRecord } from '../src/workspace/workspace.js';

const PERMISSIONS: readonly WorkspacePermission[] = ['read', 'author', 'publish', 'review', 'audit', 'manage'];
const alice = { kind: 'human' as const, id: 'alice' };

async function matrix(manager: PermissionManager): Promise<string[]> {
  const mismatches: string[] = [];
  for (const role of WORKSPACE_ROLES) {
    for (const permission of PERMISSIONS) {
      const got = await isWorkspaceAllowed(manager, { principal: alice, role, workspaceId: 'ws_1', permission });
      if (got !== roleAllows(role, permission))
        mismatches.push(`${role}/${permission}: engine ${got}, table ${roleAllows(role, permission)}`);
    }
  }
  return mismatches;
}

test('equivalence: the engine gives exactly the role table answer for all 4 roles x 6 permissions', async () => {
  assert.deepEqual(await matrix(new PermissionManager({ policy: createAuthorizationPolicy() })), []);
  // The rules are generated from the table, one per granted pair, and nothing else.
  const granted = WORKSPACE_ROLES.flatMap((r) => PERMISSIONS.filter((p) => roleAllows(r, p)));
  assert.equal(workspaceRoleRules().length, granted.length);
});

test('ceiling: an operator allow-all policy does not widen any role (matrix unchanged)', async () => {
  const allowAll = new RuleBasedPolicy([{ id: 'all', effect: 'ALLOW', match: {} }]);
  assert.deepEqual(await matrix(new PermissionManager({ policy: createAuthorizationPolicy(allowAll) })), []);
});

test('narrowing: an operator DENY for one principal removes even admin rights; other principals are unaffected', async () => {
  const suspend = new RuleBasedPolicy([{ id: 'suspend', effect: 'DENY', match: { domain: 'workspace', principalId: 'alice' } }]);
  const manager = new PermissionManager({ policy: createAuthorizationPolicy(suspend) });
  for (const permission of PERMISSIONS) {
    assert.equal(await isWorkspaceAllowed(manager, { principal: alice, role: 'admin', workspaceId: 'ws_1', permission }), false);
  }
  const bob = { kind: 'human' as const, id: 'bob' };
  assert.equal(await isWorkspaceAllowed(manager, { principal: bob, role: 'admin', workspaceId: 'ws_1', permission: 'manage' }), true);
});

test('fail closed: a policy that throws denies', async () => {
  const broken: PermissionPolicy = {
    evaluate: () => {
      throw new Error('policy engine down');
    },
  };
  const manager = new PermissionManager({ policy: createAuthorizationPolicy(broken) });
  assert.equal(await isWorkspaceAllowed(manager, { principal: alice, role: 'admin', workspaceId: 'ws_1', permission: 'read' }), false);
});

async function withServer(policy: PermissionPolicy | undefined, fn: (s: TestServer, ws: WorkspaceRecord) => Promise<void>) {
  await withTempDir('xo-uw1-data-', async (dataDir) => {
    await withTempDir('xo-uw1-ws-', async (workspacesDir) => {
      const server = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        ...(policy !== undefined ? { permissionPolicy: policy } : {}),
      });
      try {
        const created = await server.request('POST', '/workspaces', {});
        assert.ok(created.status === 200 || created.status === 201, created.bodyText);
        await fn(server, created.json<WorkspaceRecord>());
      } finally {
        await server.stop();
      }
    });
  });
}

test('routes go through the shared manager: an operator DENY on the owner turns a read into 403', async () => {
  await withServer(undefined, async (server, ws) => {
    assert.equal((await server.request('GET', `/workspaces/${ws.workspaceId}/sources`)).status, 200);
  });
  const suspendOwner = new RuleBasedPolicy([
    { id: 'suspend-owner', effect: 'DENY', match: { domain: 'workspace', principalId: 'test-identity' } },
  ]);
  await withServer(suspendOwner, async (server, ws) => {
    const r = await server.request('GET', `/workspaces/${ws.workspaceId}/sources`);
    assert.equal(r.status, 403, r.bodyText);
    const body = r.json<{ error: { context: { permission: string; deniedBy: string } } }>();
    assert.equal(body.error.context.permission, 'read');
    assert.equal(body.error.context.deniedBy, 'policy', 'the message names policy, not the role, as the reason');
  });
});

test('routes keep the role ceiling under an operator allow-all policy: a viewer can read but not author', async () => {
  await withServer(new RuleBasedPolicy([{ id: 'all', effect: 'ALLOW', match: {} }]), async (server, ws) => {
    const viewer = await server.issueAdditionalIdentity('viewer-1');
    const added = await server.request('POST', `/workspaces/${ws.workspaceId}/members`, { identityId: viewer.identityId, role: 'viewer' });
    assert.ok(added.status === 200 || added.status === 201, added.bodyText);
    const as = TestServer.authHeader(viewer.apiKey);
    assert.equal((await server.request('GET', `/workspaces/${ws.workspaceId}/sources`, undefined, as)).status, 200);
    const upload = await server.request('POST', `/workspaces/${ws.workspaceId}/members`, { identityId: 'x', role: 'admin' }, as);
    assert.equal(upload.status, 403, 'manage is outside the viewer ceiling even with an allow-all operator policy');
  });
});

// UW-1 acceptance ("empty-policy denial matrix across API, chat, procedures, AI paths"): every workspace path group, including chat,
// the AI conversation surface and procedures, asks the one authorization point. Suspending the owner by operator policy turns each into
// 403 while an unsuspended owner reaches them.
const PATH_GROUPS: readonly (readonly ['GET' | 'POST', string, unknown?])[] = [
  ['GET', 'sources'],
  ['GET', 'compilations'],
  ['GET', 'chats'],
  ['POST', 'chats', {}],
  ['GET', 'intelligence/conversations'],
  ['POST', 'intelligence/conversations', {}],
  ['GET', 'procedures'],
  ['GET', 'executions'],
  ['GET', 'human-tasks'],
  ['GET', 'inbox'],
  ['GET', 'library'],
  ['GET', 'members'],
  ['GET', 'notifications'],
  ['GET', 'registry/packages?creator=did:example:x'],
  ['GET', 'registry/search'],
  ['GET', 'runtime/status'],
  ['GET', 'settings'],
  ['GET', 'workflow-controls'],
  ['GET', 'workflow-definitions'],
  ['GET', 'workflow-executions'],
  ['GET', 'workflows'],
  ['GET', 'audit/events'],
  ['GET', 'audit/verify'],
];

test('every workspace path group (API, chat, AI conversations, procedures, workflows, audit) is decided by the one authorization point', async () => {
  const suspendOwner = new RuleBasedPolicy([
    { id: 'suspend-owner', effect: 'DENY', match: { domain: 'workspace', principalId: 'test-identity' } },
  ]);
  await withServer(suspendOwner, async (server, ws) => {
    for (const [method, path, body] of PATH_GROUPS) {
      const r = await server.request(method, `/workspaces/${ws.workspaceId}/${path}`, body);
      assert.equal(r.status, 403, `${method} ${path}: ${r.bodyText}`);
    }
  });
  // Control: the same owner, unsuspended, with the operator grant procedures need on top of the role (procedures are not role-granted).
  const procedureGrant = new RuleBasedPolicy([
    { id: 'procedures', effect: 'ALLOW', match: { domain: 'procedure', principalId: 'test-identity' } },
  ]);
  await withServer(procedureGrant, async (server, ws) => {
    for (const [method, path, body] of PATH_GROUPS) {
      const r = await server.request(method, `/workspaces/${ws.workspaceId}/${path}`, body);
      assert.notEqual(r.status, 403, `${method} ${path} must be reachable by an unsuspended owner: ${r.bodyText}`);
    }
  });
});
