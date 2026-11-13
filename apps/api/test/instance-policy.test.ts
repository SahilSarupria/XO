// UW-1 (ADR 0010): the persisted operator policy. Strictly validated, fail-closed, combined with code-supplied policy by deny-overrides,
// and unable to widen workspace roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Permissions, RuleBasedPolicy } from '@xo/permissions';
import { PackageId } from '@xo/types';
import { TestServer, withTempDir } from './test-helpers.js';
import {
  InstancePolicy,
  parseInstancePolicy,
  readInstancePolicy,
  writeInstancePolicy,
  INSTANCE_POLICY_FORMAT,
} from '../src/auth/instance-policy.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

const doc = (rules: unknown[], revision = 1) => ({ format: INSTANCE_POLICY_FORMAT, revision, rules });
const allowAudit = {
  id: 'allow.test-identity.audit-read',
  effect: 'ALLOW',
  match: { principalId: 'test-identity', permission: 'audit.read' },
};

test('parse: valid rules are accepted; every malformed shape rejects the whole document', () => {
  assert.ok(parseInstancePolicy(doc([allowAudit])).ok);
  const bad: unknown[] = [
    { ...allowAudit, effect: 'PROMPT' },
    { ...allowAudit, extra: 1 },
    { ...allowAudit, match: { principalId: 'test-identity', permission: 'audit.read', packageId: 'x' } },
    { ...allowAudit, match: { permission: 'not a permission' } },
    { ...allowAudit, match: { domain: 'nope' } },
    { ...allowAudit, match: {} },
    { ...allowAudit, match: { principalKind: 'human' } },
    { ...allowAudit, id: 'Bad Id' },
    { id: 'w', effect: 'ALLOW', match: { principalId: 'a', permission: 'workspace.author' } },
    { id: 'w2', effect: 'ALLOW', match: { principalId: 'a', domain: 'workspace' } },
    { id: 'w3', effect: 'ALLOW', match: { principalId: 'a' } },
  ];
  for (const rule of bad) assert.equal(parseInstancePolicy(doc([rule])).ok, false, JSON.stringify(rule));
  assert.equal(parseInstancePolicy(doc([allowAudit, allowAudit])).ok, false, 'duplicate ids');
  assert.equal(parseInstancePolicy({ ...doc([]), format: 2 }).ok, false);
  // A DENY may target workspace operations (suspension).
  assert.ok(parseInstancePolicy(doc([{ id: 'suspend', effect: 'DENY', match: { principalId: 'a', domain: 'workspace' } }])).ok);
});

test('file: missing is empty; invalid suspends all operator ALLOWs (fail closed); a fix takes effect on reload', async () => {
  await withTempDir('xo-ipol-', async (dir) => {
    const path = join(dir, 'policy.json');
    const request = {
      permission: Permissions.audit.read,
      requester: { packageId: PackageId('xo.api') },
      principal: { kind: 'human' as const, id: 'test-identity' },
    };
    const missing = new InstancePolicy(path);
    assert.equal(missing.lastError, undefined);
    assert.equal(missing.evaluate(request).effect, 'NO_MATCH');

    await writeFile(path, JSON.stringify(doc([allowAudit])));
    assert.equal(await missing.reload(), 1);
    assert.equal(missing.evaluate(request).effect, 'ALLOW');

    await writeFile(path, '{ not json');
    assert.equal(await missing.reload(), -1);
    assert.ok(missing.lastError !== undefined);
    assert.equal(missing.evaluate(request).effect, 'NO_MATCH', 'a broken file grants nothing');

    const atStart = new InstancePolicy(path);
    assert.ok(atStart.lastError !== undefined, 'a broken file at start-up is reported, not fatal');
    assert.equal(atStart.evaluate(request).effect, 'NO_MATCH');
  });
});

test('write: atomic, revision-checked (a concurrent change is refused, nothing is lost)', async () => {
  await withTempDir('xo-ipol-', async (dir) => {
    const path = join(dir, 'nested', 'policy.json');
    const first = await writeInstancePolicy(path, [allowAudit as never], 0);
    assert.ok(first.ok);
    assert.equal(first.value.revision, 1);
    const stale = await writeInstancePolicy(path, [], 0);
    assert.equal(stale.ok, false, 'writing against an old revision is refused');
    const read = await readInstancePolicy(path);
    assert.ok(read.ok);
    assert.equal(read.value.rules.length, 1);
  });
});

async function withServer(
  setup: (dataDir: string) => Promise<void>,
  deps: Record<string, unknown>,
  fn: (s: TestServer, ws: WorkspaceRecord) => Promise<void>,
): Promise<void> {
  await withTempDir('xo-ipol-data-', async (dataDir) => {
    await withTempDir('xo-ipol-ws-', async (workspacesDir) => {
      await setup(dataDir);
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, instancePolicyReloadMs: 0, ...deps });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        await fn(server, ws);
      } finally {
        await server.stop();
      }
    });
  });
}

const writePolicy = (rules: unknown[]) => async (dataDir: string) => {
  await mkdir(join(dataDir, '_instance'), { recursive: true });
  await writeFile(join(dataDir, '_instance', 'policy.json'), JSON.stringify(doc(rules)));
};

test('end to end: a persisted grant authorizes audit reads; without it, or with a broken file, they are refused', async () => {
  // The instance audit log (`/audit/events`) is authorized by `audit.read`, which only operator policy can grant.
  const auditStatus = (s: TestServer, _ws: WorkspaceRecord) => s.request('GET', '/audit/events').then((r) => r.status);
  await withServer(
    async () => undefined,
    {},
    async (s, ws) => assert.equal(await auditStatus(s, ws), 403),
  );
  // Authorized: the request passes the authorization gate and is then refused only because test servers run the non-durable audit
  // sink, which exposes no records (503 XO_AUDIT_UNAVAILABLE). An unauthorized request never gets that far (403 above and below).
  await withServer(writePolicy([allowAudit]), {}, async (s, ws) => {
    void ws;
    const r = await s.request('GET', '/audit/events');
    assert.equal(r.status, 503, r.bodyText);
    assert.equal(r.json<{ error: { code: string } }>().error.code, 'XO_AUDIT_UNAVAILABLE');
  });
  await withServer(
    async (dataDir) => {
      await mkdir(join(dataDir, '_instance'), { recursive: true });
      await writeFile(join(dataDir, '_instance', 'policy.json'), 'garbage');
    },
    {},
    async (s, ws) => assert.equal(await auditStatus(s, ws), 403),
  );
});

test('deny-overrides: a code-supplied ALLOW cannot override a persisted DENY, and vice versa', async () => {
  const codeAllow = new RuleBasedPolicy([
    { id: 'code', effect: 'ALLOW', match: { principalId: 'test-identity', permission: Permissions.audit.read } },
  ]);
  const fileDeny = [{ id: 'deny.test-identity.audit', effect: 'DENY', match: { principalId: 'test-identity', domain: 'audit' } }];
  await withServer(writePolicy(fileDeny), { permissionPolicy: codeAllow }, async (s, ws) => {
    assert.equal((await s.request('GET', '/audit/events')).status, 403);
    void ws;
  });
});
