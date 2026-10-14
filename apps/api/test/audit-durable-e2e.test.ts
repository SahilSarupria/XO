import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode } from '@xo/errors';
import { Permissions, RuleBasedPolicy } from '@xo/permissions';
import { FileAuditStore, SYSTEM_ACTOR, isDurableReceipt, resolveAuditConfig, type AuditEvent } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';

// P1.0 M4 acceptance evidence — the REAL durable store (FileAuditStore on a temp dir) behind the API.
// Unlike audit.test.ts / audit-workflow.test.ts (which drive most scenarios through a NonProductionAuditSink),
// nothing here substitutes the sink: events are asserted from the bytes on disk and failures are real I/O failures.

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const CAP = 'cap_rule_0f731679e7120779542267faaabe10ff';
const DAY = 86_400_000;

async function openStore(dir: string, clock?: () => Date): Promise<FileAuditStore> {
  return FileAuditStore.open({
    dir,
    retention: { defaultRetentionMs: 30 * DAY, minimumRetentionMs: 7 * DAY },
    ...(clock !== undefined ? { clock } : {}),
  });
}

async function diskEvents(file: string): Promise<AuditEvent[]> {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditEvent);
}

async function compileApproved(server: TestServer, w: string): Promise<string> {
  const bytes = await readFile(PDF);
  const src = (await server.request('POST', `/workspaces/${w}/sources?filename=policy.pdf`, bytes)).json<{ sourceId: string }>();
  const comp = (await server.request('POST', `/workspaces/${w}/sources/${src.sourceId}/compile`)).json<{
    compilationId: string;
    status: string;
  }>();
  assert.equal(comp.status, 'succeeded');
  const appr = await server.request('POST', `/workspaces/${w}/compilations/${comp.compilationId}/capabilities/${CAP}/approve`);
  assert.ok([200, 201].includes(appr.status));
  return comp.compilationId;
}

const execute = (s: TestServer, w: string, compilationId: string, headers: Record<string, string> = {}) =>
  s.request(
    'POST',
    `/workspaces/${w}/executions`,
    { compilationId, capabilityId: CAP, input: { claim_amount: 15000, loss: 'fire' } },
    headers,
  );

test('real durable store via the API: approval, execution and idempotent replay land on disk with durable fsync receipts, gap-free seq, stamped retention, no secrets; survives store re-open', async () => {
  await withTempDir('xo-audit-e2e-', async (dir) => {
    const auditDir = join(dir, 'audit');
    const store = await openStore(auditDir);
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: store });
    try {
      const w = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const compilationId = await compileApproved(server, w);
      const first = await execute(server, w, compilationId, { 'idempotency-key': 'e2e-key-0001-abcdefgh' });
      assert.equal(first.status, 201);
      const replay = await execute(server, w, compilationId, { 'idempotency-key': 'e2e-key-0001-abcdefgh' });
      assert.ok([200, 201].includes(replay.status));
      assert.equal(replay.json<{ executionId: string }>().executionId, first.json<{ executionId: string }>().executionId);

      const events = await diskEvents(join(auditDir, 'audit.jsonl'));
      const types = events.map((e) => e.type);
      for (const expected of ['approval.attempted', 'approval.granted', 'execution.started', 'execution.completed', 'idempotency.replayed'])
        assert.ok(types.includes(expected as AuditEvent['type']), `${expected} present on disk (got ${types.join(',')})`);

      // M3 ordering: the durable attempt precedes the grant; M6: started precedes completed for the one real run.
      assert.ok(types.indexOf('approval.attempted') < types.indexOf('approval.granted'));
      assert.equal(types.filter((t) => t === 'execution.completed').length, 1, 'replay did not run the capability again');

      // gap-free, strictly increasing seq; trusted fields stamped by the store; retention stamped (not defaulted by caller)
      events.forEach((e, i) => assert.equal(e.seq, (events[0] as AuditEvent).seq + i));
      assert.ok(events.every((e) => e.classification === 'restricted' && Date.parse(e.retainUntil) > Date.parse(e.recordedAt)));
      assert.ok(events.every((e) => e.actor.id === server.identityId));
      // content-free: the raw idempotency key and the capability input never reach the audit file
      const raw = await readFile(join(auditDir, 'audit.jsonl'), 'utf8');
      assert.ok(!raw.includes('e2e-key-0001-abcdefgh'));
      assert.ok(!raw.includes('claim_amount'));

      // durable receipt guarantee: a fresh append through the real store mints an fsync-file receipt
      const probe = await store.append({
        type: 'access.attempted',
        action: 'read.e2e-probe',
        outcome: 'attempted',
        actor: SYSTEM_ACTOR,
      });
      assert.ok(probe.ok);
      if (probe.ok) {
        assert.ok(isDurableReceipt(probe.receipt));
        assert.equal(probe.receipt.guarantee, 'fsync-file');
      }

      // survives a "restart": a new store over the same directory sees every earlier event and continues seq
      const reopened = await openStore(auditDir);
      const next = await reopened.append({
        type: 'access.attempted',
        action: 'read.e2e-after-restart',
        outcome: 'attempted',
        actor: SYSTEM_ACTOR,
      });
      assert.ok(next.ok);
      const after = await diskEvents(join(auditDir, 'audit.jsonl'));
      assert.equal(after.length, events.length + 2);
      after.forEach((e, i) => assert.equal(e.seq, (after[0] as AuditEvent).seq + i));
    } finally {
      await server.stop();
    }
  });
});

test('real I/O failure of the real audit file: protected read and execution start fail closed (503 XO_AUDIT_UNAVAILABLE), nothing disclosed, no execution record created; recovery needs no restart', async () => {
  await withTempDir('xo-audit-e2e-', async (dir) => {
    const auditDir = join(dir, 'audit');
    const store = await openStore(auditDir);
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: store });
    try {
      const w = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const compilationId = await compileApproved(server, w);
      const file = join(auditDir, 'audit.jsonl');
      const parked = join(auditDir, 'audit.jsonl.parked');

      // Break the real store without any monkey-patching: a directory now occupies the log's path, so open/append fail.
      await rename(file, parked);
      await mkdir(file);
      try {
        const read = await server.request('GET', `/workspaces/${w}/executions`);
        assert.equal(read.status, 503);
        assert.equal(read.json<{ error: { code: string } }>().error.code, ErrorCode.AUDIT_UNAVAILABLE);
        assert.ok(!read.bodyText.includes(auditDir), 'infrastructure paths are not exposed');

        const run = await execute(server, w, compilationId);
        assert.equal(run.status, 503, 'no side effect without a durable start record');
        assert.equal(run.json<{ error: { code: string } }>().error.code, ErrorCode.AUDIT_UNAVAILABLE);
      } finally {
        await rm(file, { recursive: true, force: true });
        await rename(parked, file);
      }

      // restored: no restart needed; and nothing ran while audit was down
      const list = await server.request('GET', `/workspaces/${w}/executions`);
      assert.equal(list.status, 200);
      assert.equal(list.json<{ executions: unknown[] }>().executions.length, 0);
    } finally {
      await server.stop();
    }
  });
});

test('purge through the API on the real store: audit.purge is required; records inside retention are NOT removed; past minimum retention they are, and an audit.purged marker remains', async () => {
  await withTempDir('xo-audit-e2e-', async (dir) => {
    const auditDir = join(dir, 'audit');
    let now = new Date('2026-01-01T00:00:00Z');
    const store = await openStore(auditDir, () => now);
    const policy = new RuleBasedPolicy([
      { id: 'read', effect: 'ALLOW', match: { permission: Permissions.audit.read, principalId: 'auditor' } },
      { id: 'purge', effect: 'ALLOW', match: { permission: Permissions.audit.purge, principalId: 'purger' } },
    ]);
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: store, permissionPolicy: policy });
    try {
      const w = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      await server.request('GET', `/workspaces/${w}/executions`); // generates an access.attempted event
      const auditor = await server.issueAdditionalIdentity('auditor');
      const purger = await server.issueAdditionalIdentity('purger');

      // read permission alone cannot purge
      const noPurge = await server.request('POST', '/audit/purge', {}, TestServer.authHeader(auditor.apiKey));
      assert.equal(noPurge.status, 403);

      // inside retention: authorized purge removes nothing
      const early = await server.request('POST', '/audit/purge', {}, TestServer.authHeader(purger.apiKey));
      assert.equal(early.status, 200);
      assert.equal(early.json<{ purged: number }>().purged, 0);
      const before = await diskEvents(join(auditDir, 'audit.jsonl'));
      assert.ok(
        before.some((e) => e.type === 'access.attempted'),
        'the event survived the early purge',
      );

      // past retainUntil (30d default, 7d minimum): the old records are removed; a content-free marker is appended
      now = new Date('2026-03-01T00:00:00Z');
      const late = await server.request('POST', '/audit/purge', {}, TestServer.authHeader(purger.apiKey));
      assert.equal(late.status, 200);
      assert.ok(late.json<{ purged: number }>().purged > 0);
      const afterPurge = await diskEvents(join(auditDir, 'audit.jsonl'));
      assert.ok(afterPurge.some((e) => e.type === 'audit.purged'));
      assert.ok(!afterPurge.some((e) => e.type === 'access.attempted' && e.action === 'list.executions'));
    } finally {
      await server.stop();
    }
  });
});

test('production-style configuration: missing, partial or inverted XO_AUDIT_* is rejected before any store is opened, and production never falls back to the volatile sink', () => {
  const bad = [
    { NODE_ENV: 'production' },
    { NODE_ENV: 'production', XO_AUDIT_DIR: '/x' },
    { XO_AUDIT_DIR: '/x', XO_AUDIT_RETENTION_DAYS: '10' },
    { XO_AUDIT_DIR: '/x', XO_AUDIT_RETENTION_DAYS: '3', XO_AUDIT_MIN_RETENTION_DAYS: '10' },
    { XO_AUDIT_DIR: '/x', XO_AUDIT_RETENTION_DAYS: '0', XO_AUDIT_MIN_RETENTION_DAYS: '0' },
  ];
  for (const env of bad) {
    const r = resolveAuditConfig(env);
    assert.equal(r.ok, false, JSON.stringify(env));
    if (!r.ok) assert.equal(r.error.code, ErrorCode.AUDIT_CONFIG_INVALID);
  }
  const good = resolveAuditConfig({
    NODE_ENV: 'production',
    XO_AUDIT_DIR: '/x',
    XO_AUDIT_RETENTION_DAYS: '30',
    XO_AUDIT_MIN_RETENTION_DAYS: '7',
  });
  assert.ok(good.ok && good.value.mode === 'durable');
});
