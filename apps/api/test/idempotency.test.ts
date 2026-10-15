import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditError, ErrorCode } from '@xo/errors';
import { Permissions, RuleBasedPolicy, establishAuthenticatedPrincipal, type PolicyRule } from '@xo/permissions';
import { NonProductionAuditSink, type AppendResult, type AuditEvent, type AuditEventDraft, type AuditSink } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { FsExecutionStore, mintExecutionId } from '../src/executions/fs-execution-store.js';
import { FsWorkflowExecutionStore } from '../src/workflows/fs-workflow-execution-store.js';
import {
  IdempotencyGate,
  fingerprintRequest,
  liveClaimCount,
  parseIdempotencyRecord,
  readIdempotencyKey,
  scopeHashOf,
  type ResourceProbe,
} from '../src/idempotency/idempotency.js';
import {
  workspaceExecutionsStore,
  workspaceIdempotencyStore,
  workspaceWorkflowExecutionsStore,
} from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

// P1.0 M6 — Idempotency. Protected operations: POST .../executions (execute.capability) and POST .../workflows/:id/executions
// (start.workflow). Concurrency tests synchronize on promises (an audit sink that parks a request at a known point), never on timing.

interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string; readonly context?: Record<string, unknown> };
}
interface ExecWire {
  readonly executionId: string;
  readonly status: string;
  readonly input?: unknown;
}
interface WfWire {
  readonly workflowExecutionId: string;
  readonly status: string;
}

const FILE = Permissions.filesystem.read;
const GRANT_FILE: PolicyRule = { id: 'grant-file', effect: 'ALLOW', match: { permission: FILE, principalId: 'test-identity' } };
const KEY = 'order-2026-10-0001';
const OTHER_KEY = 'order-2026-10-0002';
const A_INPUT = { claim_amount: 20000 };
const WF_INPUT = { claim_amount: 15000, payout_amount: 800 };

/** Parks a request at a chosen audit point and/or fails chosen audit types — all controlled by the test, none by time. */
class ControlledSink implements AuditSink {
  readonly inner = new NonProductionAuditSink();
  readonly mode = this.inner.mode;
  failTypes = new Set<string>();
  private parkType: string | undefined;
  private entered: (() => void) | undefined;
  private release: (() => void) | undefined;
  /** Next append of `type` signals `entered` and waits for `release()`. */
  park(type: string): { entered: Promise<void>; release: () => void } {
    this.parkType = type;
    const entered = new Promise<void>((r) => (this.entered = r));
    const gate = new Promise<void>((r) => (this.release = r));
    this.gate = gate;
    return { entered, release: () => this.release?.() };
  }
  private gate: Promise<void> | undefined;
  async append(draft: AuditEventDraft): Promise<AppendResult> {
    if (this.parkType === draft.type) {
      this.parkType = undefined;
      this.entered?.();
      await this.gate;
    }
    if (this.failTypes.has(draft.type)) {
      return { ok: false, error: new AuditError(ErrorCode.AUDIT_UNAVAILABLE, 'simulated outage'), indeterminate: false };
    }
    return this.inner.append(draft);
  }
  events(): readonly AuditEvent[] {
    return this.inner.events();
  }
  ofType(type: string): AuditEvent[] {
    return this.events().filter((e) => e.type === type);
  }
}

interface Env {
  readonly server: TestServer;
  readonly sink: ControlledSink;
  readonly dataDir: string;
  readonly workspacesDir: string;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
}

async function withEnv(fn: (env: Env) => Promise<void>, policy = new RuleBasedPolicy([GRANT_FILE])): Promise<void> {
  await withTempDir('xo-m6-data-', async (dataDir) => {
    await withTempDir('xo-m6-ws-', async (workspacesDir) => {
      const sink = new ControlledSink();
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, auditSink: sink, permissionPolicy: policy });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        await fn({ server, sink, dataDir, workspacesDir, workspace, compilationId });
      } finally {
        await server.stop();
      }
    });
  });
}

const ws = (env: Env, suffix: string): string => `/workspaces/${env.workspace.workspaceId}${suffix}`;
async function approve(env: Env, cap: string): Promise<void> {
  const r = await env.server.request('POST', ws(env, `/compilations/${env.compilationId}/capabilities/${cap}/approve`));
  assert.equal(r.status, 200, r.bodyText);
}
const exec = (env: Env, cap: string, input: Record<string, unknown>, key?: string, headers: Record<string, string> = {}) =>
  env.server.request(
    'POST',
    ws(env, '/executions'),
    { compilationId: env.compilationId, capabilityId: cap, input },
    { ...(key !== undefined ? { 'idempotency-key': key } : {}), ...headers },
  );
async function workflowId(env: Env, first: string): Promise<string> {
  const list = (await env.server.request('GET', ws(env, '/workflows'))).json<{
    workflows: { workflowId: string; steps: { capabilityId: string }[] }[];
  }>();
  const wf = list.workflows.find((w) => w.steps[0]?.capabilityId === first);
  assert.ok(wf);
  return wf.workflowId;
}
const startWf = (env: Env, wfId: string, input: Record<string, unknown>, key?: string) =>
  env.server.request(
    'POST',
    ws(env, `/workflows/${wfId}/executions`),
    { compilationId: env.compilationId, input },
    key !== undefined ? { 'idempotency-key': key } : {},
  );

async function storedExecutions(env: Env) {
  const store = new FsExecutionStore(workspaceExecutionsStore(env.workspace, { dataRootDir: env.dataDir }));
  const listed = await store.list();
  assert.ok(listed.ok);
  return listed.value;
}
async function storedWorkflows(env: Env) {
  const store = new FsWorkflowExecutionStore(workspaceWorkflowExecutionsStore(env.workspace, { dataRootDir: env.dataDir }));
  const listed = await store.list();
  assert.ok(listed.ok);
  return listed.value;
}
const idemDir = (env: Env, op = 'execute.capability'): string => join(env.dataDir, env.workspace.workspaceId, 'idempotency', op);
async function idemRecords(env: Env, op = 'execute.capability'): Promise<Record<string, unknown>[]> {
  let files: string[] = [];
  try {
    files = await readdir(idemDir(env, op));
  } catch {
    return [];
  }
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(idemDir(env, op), f), 'utf8')) as Record<string, unknown>));
}
const gateFor = (env: Env): IdempotencyGate => new IdempotencyGate(workspaceIdempotencyStore(env.workspace, { dataRootDir: env.dataDir }));
const principal = { kind: 'service', id: 'test-identity' } as const;
function authed() {
  const r = establishAuthenticatedPrincipal(principal);
  if (!r.ok) throw r.error;
  return r.value;
}
const fp = (cap: string, input: Record<string, unknown>, env: Env): string =>
  fingerprintRequest('execute.capability', { compilationId: env.compilationId, capabilityId: cap, input });
const neverProbe: ResourceProbe = async () => {
  throw new Error('probe must not be consulted');
};

// ── 1. first request, repeat, conflict, compatibility ───────────────────

test('first request with a key executes once; the durable record holds hashes and a resource id only — no key, no payload', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const res = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(res.status, 201, res.bodyText);
    assert.equal(res.headers['idempotent-replayed'], undefined);
    const body = res.json<ExecWire>();
    assert.equal((await storedExecutions(env)).length, 1);
    assert.equal(env.sink.ofType('execution.started').length, 1);

    const records = await idemRecords(env);
    assert.equal(records.length, 1);
    const rec = records[0]!;
    assert.equal(rec['state'], 'completed');
    assert.deepEqual(rec['resource'], { kind: 'execution', id: body.executionId });
    assert.deepEqual(rec['principal'], { kind: 'service', id: 'test-identity' });
    const raw = JSON.stringify(rec);
    assert.ok(!raw.includes(KEY), 'the client key is never stored');
    assert.ok(!raw.includes('20000') && !raw.includes('claim_amount'), 'no request payload is stored');
    assert.ok(!JSON.stringify(env.sink.events()).includes(KEY), 'the client key never reaches the audit trail');
    assert.ok(!res.bodyText.includes(KEY));
  });
});

test('a repeated equivalent request returns the established result and repeats NO side effect; audit says "replayed", not "started"', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const first = (await exec(env, IDS.flowA, A_INPUT, KEY)).json<ExecWire>();
    // Same request, input object with a different key ORDER: still equivalent.
    const again = await env.server.request(
      'POST',
      ws(env, '/executions'),
      { input: A_INPUT, capabilityId: IDS.flowA, compilationId: env.compilationId },
      { 'idempotency-key': KEY },
    );
    assert.equal(again.status, 201, again.bodyText);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.json<ExecWire>().executionId, first.executionId);
    assert.equal(again.json<ExecWire>().status, first.status);
    assert.equal((await storedExecutions(env)).length, 1, 'no second execution record');
    assert.equal(env.sink.ofType('execution.started').length, 1, 'the side-effecting path ran once');
    const replays = env.sink.ofType('idempotency.replayed');
    assert.equal(replays.length, 1);
    assert.equal(replays[0]?.actor.id, 'test-identity');
    assert.equal(replays[0]?.metadata?.['keyRef'], (await idemRecords(env))[0]!['scopeHash'].toString().slice(0, 16));
    for (let i = 0; i < 3; i++) assert.equal((await exec(env, IDS.flowA, A_INPUT, KEY)).json<ExecWire>().executionId, first.executionId);
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

test('a replay reports the established outcome even when that outcome was a FAILED execution (same key = same logical operation)', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const bad = await exec(env, IDS.flowA, { claim_amount: 'not-a-number' }, KEY);
    assert.equal(bad.status, 200, bad.bodyText);
    assert.equal(bad.json<ExecWire>().status, 'failed');
    const again = await exec(env, IDS.flowA, { claim_amount: 'not-a-number' }, KEY);
    assert.equal(again.status, 200);
    assert.equal(again.json<ExecWire>().executionId, bad.json<ExecWire>().executionId);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal((await storedExecutions(env)).length, 1, 'a failure is not silently retried under the same key');
  });
});

test('same key with materially different input, capability or compilation is rejected explicitly (422) and executes nothing', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const first = (await exec(env, IDS.flowA, A_INPUT, KEY)).json<ExecWire>();
    for (const [label, res] of [
      ['different input', await exec(env, IDS.flowA, { claim_amount: 1 }, KEY)],
      ['different capability', await exec(env, IDS.flowB, { matched: true, payout_amount: 800 }, KEY)],
    ] as const) {
      assert.equal(res.status, 422, `${label}: ${res.bodyText}`);
      assert.equal(res.json<ErrorWire>().error.code, 'XO_IDEMPOTENCY_KEY_REUSED', label);
      assert.ok(!res.bodyText.includes(first.executionId), `${label}: no unrelated result is returned`);
      assert.ok(!res.bodyText.includes(KEY), `${label}: the key is not echoed`);
    }
    assert.equal((await storedExecutions(env)).length, 1);
    assert.equal(env.sink.ofType('idempotency.conflict').length, 2);
    assert.equal(env.sink.ofType('idempotency.conflict')[0]?.outcome, 'denied');
    // The original is still replayable afterwards.
    assert.equal((await exec(env, IDS.flowA, A_INPUT, KEY)).headers['idempotent-replayed'], 'true');
  });
});

test('requests WITHOUT a key behave exactly as before (each one executes); no idempotency record is written', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    assert.equal((await exec(env, IDS.flowA, A_INPUT)).status, 201);
    assert.equal((await exec(env, IDS.flowA, A_INPUT)).status, 201);
    assert.equal((await storedExecutions(env)).length, 2);
    assert.deepEqual(await idemRecords(env), []);
    assert.equal(env.sink.ofType('idempotency.replayed').length, 0);
  });
});

test('a malformed, empty, over-long or repeated key is a 400 before anything happens, and the value is not echoed', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    for (const bad of ['short', 'has space in it', 'bad/char/slash', 'x'.repeat(129), `${KEY}, ${OTHER_KEY}`, '', '-leading-dash-key']) {
      const res = await exec(env, IDS.flowA, A_INPUT, bad);
      assert.equal(res.status, 400, `"${bad}": ${res.bodyText}`);
      assert.equal(res.json<ErrorWire>().error.code, 'XO_INVALID_ARGUMENT');
      if (bad.length > 0) assert.ok(!res.bodyText.includes(bad));
    }
    assert.equal((await storedExecutions(env)).length, 0);
  });
});

// ── 2. concurrency, timeout + retry (deterministic) ─────────────────────

test('concurrent same-key requests: while the first is parked mid-operation the second is refused (409, Retry-After) and does NOT execute; after it finishes a retry replays', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const parked = env.sink.park('execution.started'); // first request stops after it holds the claim, before any execution record exists
    const first = exec(env, IDS.flowA, A_INPUT, KEY);
    await parked.entered;
    assert.equal(liveClaimCount(), 1);

    const second = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(second.status, 409, second.bodyText);
    assert.equal(second.json<ErrorWire>().error.code, 'XO_IDEMPOTENCY_IN_PROGRESS');
    assert.equal(second.headers['retry-after'], '1');
    assert.equal((await storedExecutions(env)).length, 0, 'the duplicate did not run the operation');
    assert.equal(env.sink.ofType('idempotency.in_progress').length, 1);

    parked.release();
    const done = await first; // the "client" that timed out earlier simply never looked at this response
    assert.equal(done.status, 201, done.bodyText);
    assert.equal(liveClaimCount(), 0);

    const retry = await exec(env, IDS.flowA, A_INPUT, KEY); // timeout -> retry with the same key
    assert.equal(retry.status, 201);
    assert.equal(retry.headers['idempotent-replayed'], 'true');
    assert.equal(retry.json<ExecWire>().executionId, done.json<ExecWire>().executionId);
    assert.equal((await storedExecutions(env)).length, 1);
    assert.equal(env.sink.ofType('execution.started').length, 1);
  });
});

test('a burst of simultaneous identical requests executes exactly once; every other answer is a replay or an explicit 409, never a second run', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const results = await Promise.all(Array.from({ length: 10 }, () => exec(env, IDS.flowA, A_INPUT, KEY)));
    const fresh = results.filter((r) => r.status === 201 && r.headers['idempotent-replayed'] === undefined);
    assert.equal(fresh.length, 1);
    for (const r of results) {
      if (r === fresh[0]) continue;
      assert.ok(
        (r.status === 201 && r.headers['idempotent-replayed'] === 'true') ||
          (r.status === 409 && r.json<ErrorWire>().error.code === 'XO_IDEMPOTENCY_IN_PROGRESS'),
        `${r.status} ${r.bodyText}`,
      );
    }
    assert.equal((await storedExecutions(env)).length, 1);
    assert.equal(env.sink.ofType('execution.started').length, 1);
    assert.equal(liveClaimCount(), 0);
  });
});

test('gate level: of N simultaneous begin() calls exactly one proceeds; the rest see in_progress; after complete() all see a replay', async () => {
  await withEnv(async (env) => {
    const gate = gateFor(env);
    const input = {
      operation: 'execute.capability',
      workspaceId: env.workspace.workspaceId,
      principal,
      key: KEY,
      fingerprint: fp(IDS.flowA, A_INPUT, env),
      probe: neverProbe,
    } as const;
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => gate.begin(input)));
    const winners = outcomes.filter((o) => o.kind === 'proceed');
    assert.equal(winners.length, 1);
    assert.equal(outcomes.filter((o) => o.kind === 'in_progress').length, 11);
    const claim = (winners[0] as Extract<(typeof outcomes)[number], { kind: 'proceed' }>).claim;
    assert.equal(await claim.attach({ kind: 'execution', id: mintExecutionId() }), true);
    assert.equal(await claim.complete(), true);
    assert.equal((await gate.begin(input)).kind, 'replay');
  });
});

// ── 3. scoping: workspace, principal, operation ─────────────────────────

test('the same key in a DIFFERENT workspace is an independent operation (no shared result)', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const first = (await exec(env, IDS.flowA, A_INPUT, KEY)).json<ExecWire>();
    const ws2 = (await env.server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
    const { compilationId: c2 } = await storeFixtureCompilation(ws2, env.dataDir);
    const base2 = `/workspaces/${ws2.workspaceId}`;
    assert.equal((await env.server.request('POST', `${base2}/compilations/${c2}/capabilities/${IDS.flowA}/approve`)).status, 200);
    const res = await env.server.request(
      'POST',
      `${base2}/executions`,
      { compilationId: c2, capabilityId: IDS.flowA, input: A_INPUT },
      { 'idempotency-key': KEY },
    );
    assert.equal(res.status, 201, res.bodyText);
    assert.equal(res.headers['idempotent-replayed'], undefined);
    assert.notEqual(res.json<ExecWire>().executionId, first.executionId);
    assert.equal((await storedExecutions(env)).length, 1, 'workspace 1 is untouched by workspace 2');
  });
});

test("another principal cannot reach, replay or learn about this workspace's keyed result", async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const first = (await exec(env, IDS.flowA, A_INPUT, KEY)).json<ExecWire>();
    const other = await env.server.issueAdditionalIdentity('someone-else');
    const res = await exec(env, IDS.flowA, A_INPUT, KEY, TestServer.authHeader(other.apiKey));
    assert.equal(res.status, 404, res.bodyText);
    assert.ok(!res.bodyText.includes(first.executionId));
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

test('gate level: principal, workspace and operation are part of the scope; a record copied between scopes is never honoured', async () => {
  await withEnv(async (env) => {
    const gate = gateFor(env);
    const base = { workspaceId: env.workspace.workspaceId, key: KEY, fingerprint: fp(IDS.flowA, A_INPUT, env), probe: neverProbe } as const;
    const a = await gate.begin({ ...base, operation: 'execute.capability', principal });
    const b = await gate.begin({ ...base, operation: 'execute.capability', principal: { kind: 'service', id: 'second-principal' } });
    const c = await gate.begin({ ...base, operation: 'start.workflow', principal });
    const d = await gate.begin({ ...base, operation: 'execute.capability', principal: { kind: 'human', id: 'test-identity' } });
    for (const o of [a, b, c, d]) assert.equal(o.kind, 'proceed', 'each scope has its own claim');
    for (const o of [a, b, c, d]) if (o.kind === 'proceed') o.claim.dispose();
    assert.notEqual(
      scopeHashOf('execute.capability', 'w', principal, KEY),
      scopeHashOf('execute.capability', 'w', { kind: 'service', id: 'test-identity-' }, KEY.slice(0, -1) + '1'),
    );

    // Copy principal A's record file over principal B's slot: B must NOT be served A's result.
    const dir = idemDir(env);
    const [fileA, fileB] = [
      scopeHashOf('execute.capability', env.workspace.workspaceId, principal, KEY),
      scopeHashOf('execute.capability', env.workspace.workspaceId, { kind: 'service', id: 'second-principal' }, KEY),
    ];
    const recA = JSON.parse(await readFile(join(dir, `${fileA}.json`), 'utf8')) as Record<string, unknown>;
    await writeFile(
      join(dir, `${fileB}.json`),
      JSON.stringify({ ...recA, state: 'completed', resource: { kind: 'execution', id: mintExecutionId() } }),
    );
    const forged = await gate.begin({ ...base, operation: 'execute.capability', principal: { kind: 'service', id: 'second-principal' } });
    assert.equal(forged.kind, 'invalid_record');
  });
});

test('the same key used for an execution and for a workflow start are independent operations', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const wf = await workflowId(env, IDS.flowA);
    const e = await exec(env, IDS.flowA, A_INPUT, KEY);
    const w = await startWf(env, wf, WF_INPUT, KEY);
    assert.equal(e.status, 201, e.bodyText);
    assert.equal(w.status, 201, w.bodyText);
    assert.equal(w.headers['idempotent-replayed'], undefined);
    assert.equal((await idemRecords(env, 'execute.capability')).length, 1);
    assert.equal((await idemRecords(env, 'start.workflow')).length, 1);
  });
});

// ── 4. M1–M4 are never bypassed by a key ────────────────────────────────

test('a key never bypasses authentication, approval (M3), or authorization (M2): replays re-run every check', async () => {
  await withEnv(async (env) => {
    // M1: no credentials -> 401 even with a valid key.
    assert.equal(
      (
        await env.server.request(
          'POST',
          ws(env, '/executions'),
          { compilationId: env.compilationId, capabilityId: IDS.flowA, input: A_INPUT },
          { 'idempotency-key': KEY },
          { skipAuth: true },
        )
      ).status,
      401,
    );
    // M3: not approved -> 403, and the key is not consumed.
    assert.equal((await exec(env, IDS.flowA, A_INPUT, KEY)).status, 403);
    assert.deepEqual(await idemRecords(env), [], 'a refused request leaves no claim behind');
    await approve(env, IDS.flowA);
    const first = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(first.status, 201);

    // M3 on replay: the capability changes after approval -> the SAME key is refused (403), not served the old result.
    const resultFile = join(env.dataDir, env.workspace.workspaceId, 'compilations', env.compilationId, 'result.json');
    const stored = JSON.parse(await readFile(resultFile, 'utf8')) as {
      graph: { nodes: { id: string; properties: Record<string, unknown> }[] };
    };
    stored.graph.nodes.find((n) => n.id === 'decision_p08_flow_a')!.properties['outcome'] = 'changed after approval';
    await writeFile(resultFile, JSON.stringify(stored));
    const stale = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(stale.status, 403, stale.bodyText);
    assert.ok(!stale.bodyText.includes(first.json<ExecWire>().executionId));
    assert.equal(stale.headers['idempotent-replayed'], undefined);
    assert.equal(env.sink.ofType('idempotency.replayed').length, 0);
  });
});

test('M2 on replay across a restart: a principal who is no longer authorized cannot replay a keyed result', async () => {
  await withTempDir('xo-m6-data-', async (dataDir) => {
    await withTempDir('xo-m6-ws-', async (workspacesDir) => {
      let workspace: WorkspaceRecord;
      let compilationId: string;
      const sink = new ControlledSink();
      const serverA = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: new RuleBasedPolicy([GRANT_FILE]),
      });
      let executionId: string;
      try {
        workspace = (await serverA.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        compilationId = (await storeFixtureCompilation(workspace, dataDir)).compilationId;
        const base = `/workspaces/${workspace.workspaceId}`;
        await serverA.request('POST', `${base}/compilations/${compilationId}/capabilities/${IDS.perm}/approve`);
        const r = await serverA.request(
          'POST',
          `${base}/executions`,
          { compilationId, capabilityId: IDS.perm, input: { file_size: 50 } },
          { 'idempotency-key': KEY },
        );
        assert.equal(r.status, 201, r.bodyText);
        executionId = r.json<ExecWire>().executionId;
      } finally {
        await serverA.stop();
      }
      // "Restart": same data on disk, a policy that no longer grants this principal. (Same principal id: the key store is per-server.)
      const serverB = await TestServer.start({
        workspaceDataDir: dataDir,
        workspacesDir,
        auditSink: sink,
        permissionPolicy: new RuleBasedPolicy([]),
      });
      try {
        const base = `/workspaces/${workspace.workspaceId}`;
        const denied = await serverB.request(
          'POST',
          `${base}/executions`,
          { compilationId, capabilityId: IDS.perm, input: { file_size: 50 } },
          { 'idempotency-key': KEY },
        );
        assert.equal(denied.status, 403, denied.bodyText);
        assert.ok(!denied.bodyText.includes(executionId));
        assert.equal(sink.ofType('idempotency.replayed').length, 0);
      } finally {
        await serverB.stop();
      }
    });
  });
});

// ── 5. audit fail-closed ────────────────────────────────────────────────

test('if the start precondition cannot be audited: 503, nothing executes, the claim is released, and the same key succeeds once audit is back', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    env.sink.failTypes.add('execution.started');
    const down = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(down.status, 503, down.bodyText);
    assert.equal((await storedExecutions(env)).length, 0);
    assert.deepEqual(await idemRecords(env), [], 'released: no stranded claim');
    assert.equal(liveClaimCount(), 0);
    env.sink.failTypes.clear();
    const retry = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(retry.status, 201, retry.bodyText);
    assert.equal(retry.headers['idempotent-replayed'], undefined);
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

test('if the replay itself cannot be audited, NOTHING is disclosed (503) and nothing runs', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const first = (await exec(env, IDS.flowA, A_INPUT, KEY)).json<ExecWire>();
    env.sink.failTypes.add('idempotency.replayed');
    const res = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(res.status, 503, res.bodyText);
    assert.ok(!res.bodyText.includes(first.executionId));
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

test('a refused duplicate/conflict is enforced even if its denial record cannot be written (denials are best-effort, like every other denial)', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await exec(env, IDS.flowA, A_INPUT, KEY);
    env.sink.failTypes.add('idempotency.conflict');
    const res = await exec(env, IDS.flowA, { claim_amount: 1 }, KEY);
    assert.equal(res.status, 422);
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

// ── 6. restart + interrupted / failed recovery semantics ────────────────

test('restart: a completed keyed operation is still a replay on a fresh server over the same data (durable, never looks new)', async () => {
  await withTempDir('xo-m6-data-', async (dataDir) => {
    await withTempDir('xo-m6-ws-', async (workspacesDir) => {
      const sink = new ControlledSink();
      const mk = () =>
        TestServer.start({
          workspaceDataDir: dataDir,
          workspacesDir,
          auditSink: sink,
          permissionPolicy: new RuleBasedPolicy([GRANT_FILE]),
        });
      const a = await mk();
      let workspace: WorkspaceRecord;
      let compilationId: string;
      let executionId: string;
      try {
        workspace = (await a.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        compilationId = (await storeFixtureCompilation(workspace, dataDir)).compilationId;
        const base = `/workspaces/${workspace.workspaceId}`;
        await a.request('POST', `${base}/compilations/${compilationId}/capabilities/${IDS.flowA}/approve`);
        executionId = (
          await a.request(
            'POST',
            `${base}/executions`,
            { compilationId, capabilityId: IDS.flowA, input: A_INPUT },
            { 'idempotency-key': KEY },
          )
        ).json<ExecWire>().executionId;
      } finally {
        await a.stop();
      }
      const b = await mk();
      try {
        const base = `/workspaces/${workspace.workspaceId}`;
        const res = await b.request(
          'POST',
          `${base}/executions`,
          { compilationId, capabilityId: IDS.flowA, input: A_INPUT },
          { 'idempotency-key': KEY },
        );
        assert.equal(res.status, 201, res.bodyText);
        assert.equal(res.headers['idempotent-replayed'], 'true');
        assert.equal(res.json<ExecWire>().executionId, executionId);
        const list = await b.request('GET', `${base}/executions`);
        assert.equal(list.json<{ executions: unknown[] }>().executions.length, 1);
      } finally {
        await b.stop();
      }
    });
  });
});

/** Leaves exactly what a process that died mid-operation leaves: an in_progress record, no live owner. */
async function strandClaim(env: Env, opts: { resource?: 'none' | 'placeholder' | 'completed' | 'absent' }): Promise<string | undefined> {
  const gate = gateFor(env);
  const begin = await gate.begin({
    operation: 'execute.capability',
    workspaceId: env.workspace.workspaceId,
    principal,
    key: KEY,
    fingerprint: fp(IDS.flowA, A_INPUT, env),
    probe: neverProbe,
  });
  assert.equal(begin.kind, 'proceed');
  if (begin.kind !== 'proceed') return undefined;
  let id: string | undefined;
  if (opts.resource !== undefined && opts.resource !== 'none') {
    id = mintExecutionId();
    assert.equal(await begin.claim.attach({ kind: 'execution', id }), true);
    if (opts.resource !== 'absent') {
      const store = new FsExecutionStore(workspaceExecutionsStore(env.workspace, { dataRootDir: env.dataDir }));
      const created = await store.create(env.workspace.workspaceId, authed(), {
        compilationId: env.compilationId,
        capabilityId: IDS.flowA,
        input: A_INPUT,
        executionId: id,
      });
      assert.ok(created.ok);
      if (opts.resource === 'completed') assert.ok((await store.complete(id, { status: 'succeeded', output: { matched: true } })).ok);
    }
  }
  begin.claim.dispose(); // the process "dies": no abort, no complete — the record stays in_progress with no live owner
  assert.equal(liveClaimCount(), 0);
  return id;
}

test('interrupted BEFORE any resource was named: side effects cannot have started, so the retry safely takes over and executes once', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await strandClaim(env, { resource: 'none' });
    const res = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(res.status, 201, res.bodyText);
    assert.equal(res.headers['idempotent-replayed'], undefined);
    assert.equal((await storedExecutions(env)).length, 1);
    assert.equal(env.sink.ofType('execution.started')[0]?.metadata?.['takeover'], true);
    assert.equal((await exec(env, IDS.flowA, A_INPUT, KEY)).headers['idempotent-replayed'], 'true');
  });
});

test('interrupted after the id was reserved but BEFORE the record existed: nothing ran, so the retry takes over and executes once', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await strandClaim(env, { resource: 'absent' });
    const res = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(res.status, 201, res.bodyText);
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

test('interrupted AFTER the execution started and its end cannot be proven: refused (409), NOT re-run, NOT reported as success, and audited as indeterminate', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const stranded = await strandClaim(env, { resource: 'placeholder' });
    for (let i = 0; i < 2; i++) {
      const res = await exec(env, IDS.flowA, A_INPUT, KEY);
      assert.equal(res.status, 409, res.bodyText);
      const err = res.json<ErrorWire>().error;
      assert.equal(err.code, 'XO_IDEMPOTENCY_OUTCOME_UNKNOWN');
      assert.deepEqual(err.context, { resourceKind: 'execution', resourceId: stranded });
    }
    assert.equal((await storedExecutions(env)).length, 1, 'the stranded execution is still the only one: nothing was re-run');
    assert.equal(env.sink.ofType('execution.started').length, 0);
    assert.equal(env.sink.ofType('idempotency.indeterminate').length, 2);
    // The documented way forward is an explicit NEW key.
    assert.equal((await exec(env, IDS.flowA, A_INPUT, OTHER_KEY)).status, 201);
  });
});

test('interrupted AFTER the execution finished but before the key was marked: the retry ADOPTS the recorded result (audited as recovered) and never re-runs', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const stranded = await strandClaim(env, { resource: 'completed' });
    const res = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(res.status, 201, res.bodyText);
    assert.equal(res.headers['idempotent-replayed'], 'true');
    assert.equal(res.json<ExecWire>().executionId, stranded);
    assert.equal((await storedExecutions(env)).length, 1);
    assert.equal(env.sink.ofType('idempotency.recovered').length, 1);
    assert.equal(env.sink.ofType('idempotency.replayed').length, 0);
    assert.equal((await idemRecords(env))[0]!['state'], 'completed', 'the adoption was made durable');
  });
});

test("a stranded record naming a resource that is NOT this principal's is never served (fail closed, 500) and runs nothing", async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    const stranded = await strandClaim(env, { resource: 'completed' });
    const file = join(env.dataDir, env.workspace.workspaceId, 'executions', stranded!, 'metadata.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...rec, identityId: 'someone-else' }));
    const res = await exec(env, IDS.flowA, A_INPUT, KEY);
    assert.equal(res.status, 500, res.bodyText);
    assert.equal(res.json<ErrorWire>().error.code, 'XO_IDEMPOTENCY_RECORD_INVALID');
    assert.ok(!res.bodyText.includes(stranded!));
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

test('corrupt or tampered idempotency records fail closed (never executed, never replayed)', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    assert.equal((await exec(env, IDS.flowA, A_INPUT, KEY)).status, 201);
    const file = join(idemDir(env), (await readdir(idemDir(env)))[0]!);
    const good = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    for (const [label, content] of [
      ['not json', '{nope'],
      ['unknown field', JSON.stringify({ ...good, grant: 'all' })],
      ['unknown version', JSON.stringify({ ...good, schemaVersion: 2 })],
      ['completed without a resource', JSON.stringify({ ...good, resource: undefined })],
      ['other workspace', JSON.stringify({ ...good, workspaceId: 'ws_other' })],
    ] as const) {
      await writeFile(file, content);
      const res = await exec(env, IDS.flowA, A_INPUT, KEY);
      assert.equal(res.status, 500, `${label}: ${res.bodyText}`);
      assert.equal(res.json<ErrorWire>().error.code, 'XO_IDEMPOTENCY_RECORD_INVALID', label);
    }
    assert.equal((await storedExecutions(env)).length, 1);
  });
});

// ── 7. workflow start ───────────────────────────────────────────────────

test('workflow start: a repeated keyed request returns the same workflow and starts nothing new; a different input is a 422', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const wf = await workflowId(env, IDS.flowA);
    const first = await startWf(env, wf, WF_INPUT, KEY);
    assert.equal(first.status, 201, first.bodyText);
    const id = first.json<WfWire>().workflowExecutionId;
    const stepExecutions = (await storedExecutions(env)).length;
    assert.equal(stepExecutions, 2);

    const again = await startWf(env, wf, WF_INPUT, KEY);
    assert.equal(again.status, 201, again.bodyText);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.json<WfWire>().workflowExecutionId, id);
    assert.equal((await storedWorkflows(env)).length, 1);
    assert.equal((await storedExecutions(env)).length, stepExecutions, 'no step ran again');
    assert.equal(env.sink.ofType('idempotency.replayed').length, 1);

    const diff = await startWf(env, wf, { claim_amount: 1, payout_amount: 1 }, KEY);
    assert.equal(diff.status, 422);
    assert.equal(diff.json<ErrorWire>().error.code, 'XO_IDEMPOTENCY_KEY_REUSED');
    assert.equal((await storedWorkflows(env)).length, 1);
  });
});

test('workflow start: approval (M3) is re-checked on a keyed retry — a stale step approval refuses the replay', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const wf = await workflowId(env, IDS.flowA);
    assert.equal((await startWf(env, wf, WF_INPUT, KEY)).status, 201);
    const resultFile = join(env.dataDir, env.workspace.workspaceId, 'compilations', env.compilationId, 'result.json');
    const stored = JSON.parse(await readFile(resultFile, 'utf8')) as {
      graph: { nodes: { id: string; properties: Record<string, unknown> }[] };
    };
    stored.graph.nodes.find((n) => n.id === 'decision_p08_flow_b')!.properties['outcome'] = 'changed after approval';
    await writeFile(resultFile, JSON.stringify(stored));
    const res = await startWf(env, wf, WF_INPUT, KEY);
    assert.equal(res.status, 403, res.bodyText);
    assert.equal(res.headers['idempotent-replayed'], undefined);
    assert.equal((await storedWorkflows(env)).length, 1);
  });
});

test('workflow start: a refusal before anything is persisted (not approved) consumes no key; interrupted-after-creation is replayed with its reconciled status, never restarted', async () => {
  await withEnv(async (env) => {
    const wf = await workflowId(env, IDS.flowA);
    assert.equal((await startWf(env, wf, WF_INPUT, KEY)).status, 403);
    assert.deepEqual(await idemRecords(env, 'start.workflow'), []);
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);

    // A process that died after creating the workflow record: in_progress claim + record exists, no live owner.
    const gate = gateFor(env);
    const wfInput = { compilationId: env.compilationId, workflowId: wf, input: WF_INPUT };
    const begin = await gate.begin({
      operation: 'start.workflow',
      workspaceId: env.workspace.workspaceId,
      principal,
      key: KEY,
      fingerprint: fingerprintRequest('start.workflow', wfInput),
      probe: neverProbe,
    });
    assert.equal(begin.kind, 'proceed');
    if (begin.kind !== 'proceed') return;
    const created = (await startWf(env, wf, WF_INPUT)).json<WfWire>(); // an ordinary un-keyed start stands in for the record the dead process created
    assert.equal(await begin.claim.attach({ kind: 'workflow-execution', id: created.workflowExecutionId }), true);
    begin.claim.dispose();
    const before = (await storedWorkflows(env)).length;

    const res = await startWf(env, wf, WF_INPUT, KEY);
    assert.equal(res.status, 201, res.bodyText);
    assert.equal(res.headers['idempotent-replayed'], 'true');
    assert.equal(res.json<WfWire>().workflowExecutionId, created.workflowExecutionId);
    assert.equal((await storedWorkflows(env)).length, before, 'no second workflow was started');
    assert.equal(env.sink.ofType('idempotency.recovered').length, 1);
  });
});

// ── 8. units: key syntax, fingerprint, record parsing ───────────────────

test('key syntax and fingerprint equivalence', () => {
  assert.equal(readIdempotencyKey({}).ok, true);
  assert.equal(readIdempotencyKey({ 'idempotency-key': 'abcdefgh' }).ok, true);
  assert.equal(readIdempotencyKey({ 'idempotency-key': 'abcdefg' }).ok, false);
  assert.equal(readIdempotencyKey({ 'idempotency-key': ['abcdefgh', 'ijklmnop'] }).ok, false);
  const a = fingerprintRequest('execute.capability', { compilationId: 'c', capabilityId: 'k', input: { a: 1, b: { x: 1, y: [1, 2] } } });
  const b = fingerprintRequest('execute.capability', { input: { b: { y: [1, 2], x: 1 }, a: 1 }, capabilityId: 'k', compilationId: 'c' });
  assert.equal(a, b, 'object key order does not matter');
  assert.notEqual(
    a,
    fingerprintRequest('execute.capability', { compilationId: 'c', capabilityId: 'k', input: { a: 1, b: { x: 1, y: [2, 1] } } }),
    'array order does',
  );
  assert.notEqual(
    a,
    fingerprintRequest('start.workflow', { compilationId: 'c', capabilityId: 'k', input: { a: 1, b: { x: 1, y: [1, 2] } } }),
    'operation is part of it',
  );
});

test('record parsing is strict', () => {
  const ok = {
    schemaVersion: 1,
    operation: 'execute.capability',
    workspaceId: 'w',
    principal: { kind: 'service', id: 'p' },
    scopeHash: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64),
    state: 'in_progress',
    claimedAt: 't',
    updatedAt: 't',
  };
  assert.ok(parseIdempotencyRecord(ok));
  for (const bad of [
    { ...ok, extra: 1 },
    { ...ok, schemaVersion: 2 },
    { ...ok, state: 'failed' },
    { ...ok, state: 'completed' },
    { ...ok, scopeHash: 'short' },
    { ...ok, principal: { kind: 'service', id: 'p', roles: ['admin'] } },
    { ...ok, resource: { kind: 'execution', id: 'x', extra: 1 } },
    { ...ok, operation: 'delete.everything' },
    null,
    [],
  ]) {
    assert.equal(parseIdempotencyRecord(bad), undefined, JSON.stringify(bad));
  }
});
