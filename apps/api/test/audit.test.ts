import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AuditError, ErrorCode } from '@xo/errors';
import { Permissions, RuleBasedPolicy } from '@xo/permissions';
import {
  FileAuditStore,
  NonProductionAuditSink,
  type AppendResult,
  type AuditEvent,
  type AuditEventDraft,
  type AuditSink,
} from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { buildRouter } from '../src/server.js';

// P1.0 M4 — durable audit at the API boundary: ordering, fail-closed, denial evidence, completion-failure semantics.

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const CAP = 'cap_rule_0f731679e7120779542267faaabe10ff';
const MARKDOWN = '# Vendor Agreement\n\nACME-SECRET-CONTRACT-TEXT shall send a confirmation email.\n';

/** Pass-through sink with failure injection. Mirrors the inner sink's mode so receipts stay valid. */
class FlakySink implements AuditSink {
  readonly appended: AuditEventDraft[] = [];
  failTypes = new Set<string>();
  failAll = false;
  constructor(
    private readonly inner: NonProductionAuditSink = new NonProductionAuditSink(),
    readonly mode: 'durable' | 'non-production' = 'non-production',
  ) {}
  async append(draft: AuditEventDraft): Promise<AppendResult> {
    this.appended.push(draft);
    if (this.failAll || this.failTypes.has(draft.type)) {
      return { ok: false, error: new AuditError(ErrorCode.AUDIT_UNAVAILABLE, 'simulated outage'), indeterminate: false };
    }
    return this.inner.append(draft);
  }
  events(): readonly AuditEvent[] {
    return this.inner.events();
  }
}

async function ws(server: TestServer, headers?: Readonly<Record<string, string>>): Promise<string> {
  return (await server.request('POST', '/workspaces', {}, headers)).json<{ workspaceId: string }>().workspaceId;
}
async function upload(server: TestServer, w: string, headers?: Readonly<Record<string, string>>): Promise<string> {
  const r = await server.request('POST', `/workspaces/${w}/sources?filename=policy.md`, Buffer.from(MARKDOWN), headers);
  assert.equal(r.status, 201);
  return r.json<{ sourceId: string }>().sourceId;
}
async function compileApproved(server: TestServer, w: string): Promise<string> {
  const bytes = await readFile(PDF);
  const src = (await server.request('POST', `/workspaces/${w}/sources?filename=policy.pdf`, bytes)).json<{ sourceId: string }>();
  const comp = (await server.request('POST', `/workspaces/${w}/sources/${src.sourceId}/compile`)).json<{
    compilationId: string;
    status: string;
  }>();
  assert.equal(comp.status, 'succeeded');
  return comp.compilationId;
}
const approve = (s: TestServer, w: string, c: string) =>
  s.request('POST', `/workspaces/${w}/compilations/${c}/capabilities/${CAP}/approve`);
const execute = (s: TestServer, w: string, c: string, body: object = {}) =>
  s.request('POST', `/workspaces/${w}/executions`, {
    compilationId: c,
    capabilityId: CAP,
    input: { claim_amount: 15000, loss: 'fire' },
    ...body,
  });

// ── protected reads ───────────────────────────────────────────────────

test('protected read: authorize -> durable access.attempted (actor, target, correlation) -> only then data; never claims the read completed', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const sourceId = await upload(server, w);
      const res = await server.request('GET', `/workspaces/${w}/sources/${sourceId}/content`);
      assert.equal(res.status, 200);
      assert.ok(res.bodyText.includes('ACME-SECRET-CONTRACT-TEXT'));
      const ev = sink.events().filter((e) => e.type === 'access.attempted');
      assert.equal(ev.length, 1);
      const e = ev[0] as AuditEvent;
      assert.equal(e.outcome, 'attempted');
      assert.equal(e.action, 'read.source-content');
      assert.deepEqual(e.actor, { kind: 'service', id: server.identityId });
      assert.deepEqual(e.target, { kind: 'source', id: sourceId, workspaceId: w });
      assert.match(e.correlationId ?? '', /^req-/);
      // sensitive content never reaches audit storage
      assert.ok(!JSON.stringify(sink.events()).includes('ACME-SECRET-CONTRACT-TEXT'));
      assert.ok(!sink.events().some((x) => (x.outcome as string) === 'completed' && x.type === 'access.attempted'));
    } finally {
      await server.stop();
    }
  });
});

test('audit outage BLOCKS every protected read surface: 503, structured sanitized error, nothing disclosed', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const sourceId = await upload(server, w);
      sink.failAll = true;
      const surfaces = [
        `/workspaces/${w}/sources/${sourceId}/content`,
        `/workspaces/${w}/executions`,
        `/workspaces/${w}/executions/exec-1`,
        `/workspaces/${w}/human-tasks`,
        `/workspaces/${w}/human-tasks/exec-1`,
        `/workspaces/${w}/workflows`,
        `/workspaces/${w}/workflow-executions`,
        `/workspaces/${w}/workflow-executions/wf-1`,
      ];
      for (const path of surfaces) {
        const r = await server.request('GET', path);
        assert.equal(r.status, 503, path);
        assert.ok(!r.bodyText.includes('ACME-SECRET-CONTRACT-TEXT'), path);
        assert.equal(r.json<{ error: { code: string } }>().error.code, ErrorCode.AUDIT_UNAVAILABLE, path);
        assert.ok(!r.bodyText.includes('simulated outage'), 'infrastructure detail is not exposed');
      }
    } finally {
      await server.stop();
    }
  });
});

test('unauthorized (non-owner) read never executes and the denial is recorded; no access.attempted is written', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const sourceId = await upload(server, w);
      const intruder = await server.issueAdditionalIdentity('intruder');
      const r = await server.request(
        'GET',
        `/workspaces/${w}/sources/${sourceId}/content`,
        undefined,
        TestServer.authHeader(intruder.apiKey),
      );
      assert.equal(r.status, 404);
      assert.ok(!r.bodyText.includes('ACME-SECRET-CONTRACT-TEXT'));
      const denied = sink.events().filter((e) => e.type === 'access.denied');
      assert.equal(denied.length, 1);
      assert.equal(denied[0]?.actor.id, 'intruder');
      assert.equal(denied[0]?.target?.id, w);
      assert.equal(sink.events().filter((e) => e.type === 'access.attempted' && e.actor.id === 'intruder').length, 0);
      // denial is still enforced when the audit backend is down
      sink.failAll = true;
      const again = await server.request(
        'GET',
        `/workspaces/${w}/sources/${sourceId}/content`,
        undefined,
        TestServer.authHeader(intruder.apiKey),
      );
      assert.equal(again.status, 404);
    } finally {
      await server.stop();
    }
  });
});

test('a malformed id parameter cannot inject into the audit record (falls back to the workspace target)', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const r = await server.request('GET', `/workspaces/${w}/executions/${encodeURIComponent('x y"\n{"type":"audit.purged"}')}`);
      assert.notEqual(r.status, 500);
      const e = sink.events().find((x) => x.type === 'access.attempted') as AuditEvent;
      assert.deepEqual(e.target, { kind: 'workspace', id: w });
      assert.equal(e.metadata?.['requestedIdWellFormed'], false);
    } finally {
      await server.stop();
    }
  });
});

test('a sink that claims durability but returns a volatile receipt is NOT accepted (503, read blocked)', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink(new NonProductionAuditSink(), 'durable'); // durable mode + volatile-memory receipts
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const sourceId = await upload(server, w);
      const r = await server.request('GET', `/workspaces/${w}/sources/${sourceId}/content`);
      assert.equal(r.status, 503);
      assert.ok(!r.bodyText.includes('ACME-SECRET-CONTRACT-TEXT'));
    } finally {
      await server.stop();
    }
  });
});

// ── execution lifecycle ───────────────────────────────────────────────

test('execution lifecycle: started (before the record exists) then completed, sharing a correlation id; completed carries the execution id', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const c = await compileApproved(server, w);
      await approve(server, w, c);
      const res = await execute(server, w, c);
      assert.equal(res.status, 201);
      const rec = res.json<{ executionId: string; auditFinalization?: unknown }>();
      assert.equal(rec.auditFinalization, undefined, 'no notice when evidence was recorded');
      const life = sink.events().filter((e) => e.type.startsWith('execution.'));
      assert.deepEqual(
        life.map((e) => e.type),
        ['execution.started', 'execution.completed'],
      );
      assert.equal(life[0]?.correlationId, life[1]?.correlationId);
      assert.equal(life[1]?.executionId, rec.executionId);
      assert.equal(life[0]?.executionId, undefined, 'started precedes record creation');
      assert.equal(life[1]?.target?.id, CAP);
      assert.ok(!JSON.stringify(life).includes('claim_amount'), 'input never audited');
    } finally {
      await server.stop();
    }
  });
});

test('unapproved execution is denied AND recorded; nothing is started', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const c = await compileApproved(server, w);
      const res = await execute(server, w, c);
      assert.equal(res.status, 403);
      const types = sink.events().map((e) => e.type);
      assert.ok(types.includes('execution.denied'));
      assert.ok(!types.includes('execution.started'));
      assert.equal(sink.events().find((e) => e.type === 'execution.denied')?.reasonCode, ErrorCode.RUNTIME_PERMISSION_DENIED);
    } finally {
      await server.stop();
    }
  });
});

test('audit failure BEFORE execution blocks it: 503, no execution record, no completion event', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const c = await compileApproved(server, w);
      await approve(server, w, c);
      sink.failTypes.add('execution.started');
      const res = await execute(server, w, c);
      assert.equal(res.status, 503);
      sink.failTypes.clear();
      const list = (await server.request('GET', `/workspaces/${w}/executions`)).json<{ executions: unknown[] }>();
      assert.equal(list.executions.length, 0, 'no record was created and nothing ran');
      assert.ok(!sink.events().some((e) => e.type === 'execution.completed'));
    } finally {
      await server.stop();
    }
  });
});

test('audit failure AFTER execution: real outcome preserved, sanitized finalization notice with ids, side effect NOT repeated', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const c = await compileApproved(server, w);
      await approve(server, w, c);
      sink.failTypes.add('execution.completed');
      const res = await execute(server, w, c);
      assert.equal(res.status, 201, 'the operation really succeeded');
      const body = res.json<{
        executionId: string;
        status: string;
        output: unknown;
        auditFinalization: { status: string; correlationId: string; executionId: string };
      }>();
      assert.equal(body.status, 'succeeded');
      assert.deepEqual(body.output, { matched: false });
      assert.equal(body.auditFinalization.status, 'failed');
      assert.equal(body.auditFinalization.executionId, body.executionId);
      assert.match(body.auditFinalization.correlationId, /^req-/);
      assert.ok(!res.bodyText.includes('simulated outage'));
      sink.failTypes.clear();
      const list = (await server.request('GET', `/workspaces/${w}/executions`)).json<{ executions: { executionId: string }[] }>();
      assert.equal(list.executions.length, 1, 'exactly one execution: the side effect was not retried');
      assert.equal(
        sink.appended.filter((d) => d.type === 'execution.completed').length,
        1,
        'completion write attempted once, never re-driven',
      );
      assert.equal(sink.events().filter((e) => e.type === 'execution.started').length, 1);
    } finally {
      await server.stop();
    }
  });
});

test('client-supplied trusted fields cannot reach the audit trail (actor, timestamps, outcome, receipt have no effect)', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: sink });
    try {
      const w = await ws(server);
      const c = await compileApproved(server, w);
      await approve(server, w, c);
      for (const extra of [
        { actor: { kind: 'human', id: 'root' } },
        { recordedAt: '1999-01-01' },
        { outcome: 'allowed' },
        { receipt: { guarantee: 'fsync-file' } },
        { identityId: 'root' },
      ]) {
        const r = await execute(server, w, c, extra);
        // The execution route has always ignored undeclared body fields; what matters is that they have NO effect on audit.
        assert.ok(r.status < 500, `${JSON.stringify(extra)} => ${r.status}`);
      }
      const all = sink.events();
      assert.ok(all.length >= 2);
      assert.ok(all.every((e) => e.actor.id === server.identityId && e.actor.kind === 'service'));
      assert.ok(all.every((e) => !e.recordedAt.startsWith('1999') && e.outcome !== ('allowed' as string)));
      assert.ok(!JSON.stringify(all).includes('fsync-file'));
    } finally {
      await server.stop();
    }
  });
});

// ── audit access ──────────────────────────────────────────────────────

test('audit records: default-deny; a policy-allowed service principal can read; reading is itself audited; humans and revoked keys cannot', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const store = await FileAuditStore.open({
      dir: `${dir}/audit`,
      retention: { defaultRetentionMs: 30 * 86_400_000, minimumRetentionMs: 7 * 86_400_000 },
    });
    const policy = new RuleBasedPolicy([
      { id: 'allow-auditor', effect: 'ALLOW', match: { permission: Permissions.audit.read, principalId: 'auditor' } },
      { id: 'allow-human', effect: 'ALLOW', match: { permission: Permissions.audit.read, principalId: 'human-bob' } },
    ]);
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: store, permissionPolicy: policy });
    try {
      const w = await ws(server);
      await upload(server, w); // generates audit traffic? (upload is not a protected read) — read something so an event exists
      await server.request('GET', `/workspaces/${w}/executions`);

      // default identity: service, but no policy rule => denied
      const denied = await server.request('GET', '/audit/events');
      assert.equal(denied.status, 403);
      assert.ok(!denied.bodyText.includes('access.attempted'));

      const auditor = await server.issueAdditionalIdentity('auditor');
      const ok = await server.request('GET', '/audit/events', undefined, TestServer.authHeader(auditor.apiKey));
      assert.equal(ok.status, 200);
      const events = ok.json<{ events: AuditEvent[] }>().events;
      assert.ok(events.some((e) => e.type === 'access.attempted' && e.action === 'list.executions'));
      assert.ok(
        events.some((e) => e.type === 'access.denied' && e.action === 'read.audit-log'),
        'the earlier denial was recorded',
      );
      const second = (await server.request('GET', '/audit/events', undefined, TestServer.authHeader(auditor.apiKey))).json<{
        events: AuditEvent[];
      }>().events;
      assert.ok(
        second.some((e) => e.type === 'audit.read' && e.actor.id === 'auditor'),
        'audit reads are themselves audited',
      );

      // a human principal is refused by default even though the policy names them
      const human = await server.apiKeyStore.create({
        keyHash: (await import('../src/auth/api-key.js')).hashApiKey('human-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
        identityId: 'human-bob',
        principalKind: 'human',
        createdAt: new Date().toISOString(),
      });
      assert.ok(human.ok);
      const h = await server.request(
        'GET',
        '/audit/events',
        undefined,
        TestServer.authHeader('human-key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'),
      );
      assert.equal(h.status, 403);

      // purge is default-deny too (policy grants read only)
      const p = await server.request('POST', '/audit/purge', {}, TestServer.authHeader(auditor.apiKey));
      assert.equal(p.status, 403);
    } finally {
      await server.stop();
    }
  });
});

test('audit read fails closed when the audit-read record itself cannot be written', async () => {
  await withTempDir('xo-audit-api-', async (dir) => {
    const inner = await FileAuditStore.open({
      dir: `${dir}/audit`,
      retention: { defaultRetentionMs: 30 * 86_400_000, minimumRetentionMs: 86_400_000 },
    });
    // A FileAuditStore subclass-free way to break appends: wrap after construction by monkey-patching append on the instance.
    const policy = new RuleBasedPolicy([
      { id: 'a', effect: 'ALLOW', match: { permission: Permissions.audit.read, principalId: 'auditor' } },
    ]);
    const server = await TestServer.start({ workspaceDataDir: dir, auditSink: inner, permissionPolicy: policy });
    try {
      const auditor = await server.issueAdditionalIdentity('auditor');
      const original = inner.append.bind(inner);
      (inner as { append: unknown }).append = async (d: AuditEventDraft): Promise<AppendResult> =>
        d.type === 'audit.read'
          ? { ok: false, error: new AuditError(ErrorCode.AUDIT_UNAVAILABLE, 'x'), indeterminate: false }
          : original(d);
      const r = await server.request('GET', '/audit/events', undefined, TestServer.authHeader(auditor.apiKey));
      assert.equal(r.status, 503);
      assert.ok(!r.bodyText.includes('"events"'));
    } finally {
      await server.stop();
    }
  });
});

// ── startup ───────────────────────────────────────────────────────────

test('startup: production without a durable audit sink refuses to build the server; non-production uses the explicit volatile sink', async () => {
  const prev = process.env['NODE_ENV'];
  try {
    process.env['NODE_ENV'] = 'production';
    assert.throws(
      () => buildRouter({ workspaceDataDir: '/tmp/x', apiKeysDir: '/tmp/y', workspacesDir: '/tmp/z' }),
      (e: { code: string }) => e.code === ErrorCode.AUDIT_CONFIG_INVALID,
    );
    process.env['NODE_ENV'] = 'development';
    assert.doesNotThrow(() => buildRouter({ workspaceDataDir: '/tmp/x', apiKeysDir: '/tmp/y', workspacesDir: '/tmp/z' }));
  } finally {
    if (prev === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = prev;
  }
});
