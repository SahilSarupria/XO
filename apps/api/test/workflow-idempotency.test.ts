import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import {
  assertLegitimateReplay,
  idempotentWorkflowExecutionId,
  parseIdempotencyKey,
  IDEMPOTENCY_WINDOW_MS,
} from '../src/workflows/workflow-idempotency.js';

interface RunWire {
  readonly workflowExecutionId: string;
  readonly status: string;
  readonly revision: number;
  readonly currentStepExecutionId?: string;
  readonly createdAt: string;
}
interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string; readonly context?: Record<string, unknown> };
}
interface Env {
  readonly dataDir: string;
  readonly workspacesDir: string;
  server: TestServer;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-idem-data-', async (dataDir) => {
    await withTempDir('xo-idem-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      const env: { -readonly [K in keyof Env]: Env[K] } = {
        dataDir,
        workspacesDir,
        server,
        workspace: undefined as never,
        compilationId: '',
      };
      try {
        env.workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        env.compilationId = (await storeFixtureCompilation(env.workspace, dataDir)).compilationId;
        await fn(env);
      } finally {
        await env.server.stop();
      }
    });
  });
}

const ws = (env: Env, suffix: string): string => `/workspaces/${env.workspace.workspaceId}${suffix}`;
const KEY = 'start-key-0001';
const INPUT = { screening_score: 90, settlement_amount: 800 };

async function approveChain(env: Env): Promise<void> {
  for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) {
    const res = await env.server.request('POST', ws(env, `/compilations/${env.compilationId}/capabilities/${id}/approve`));
    assert.ok(res.status === 200 || res.status === 201, res.bodyText);
  }
}
async function chainWorkflowId(env: Env): Promise<string> {
  const res = await env.server.request('GET', ws(env, '/workflows'));
  const found = res
    .json<{ workflows: { workflowId: string; steps: { capabilityId: string }[] }[] }>()
    .workflows.find((w) => w.steps[0]?.capabilityId === IDS.hitlA);
  assert.ok(found);
  return found.workflowId;
}
async function start(
  env: Env,
  key: string | undefined,
  input: Record<string, unknown> = INPUT,
  server: TestServer = env.server,
  extra: Record<string, string> = {},
) {
  const workflowId = await chainWorkflowId(env);
  const headers = { ...(key !== undefined ? { 'idempotency-key': key } : {}), ...extra };
  return server.request('POST', ws(env, `/workflows/${workflowId}/executions`), { compilationId: env.compilationId, input }, headers);
}
async function runs(env: Env): Promise<RunWire[]> {
  return (await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: RunWire[] }>().workflowExecutions;
}
async function execCount(env: Env): Promise<number> {
  return (await env.server.request('GET', ws(env, '/executions'))).json<{ executions: unknown[] }>().executions.length;
}

test('idempotency: pure helpers — key shape, scoping of the derived id, request equality, and the window', () => {
  assert.equal(parseIdempotencyKey(undefined), undefined);
  assert.equal(parseIdempotencyKey('abcDEF12-_.:'), 'abcDEF12-_.:');
  for (const bad of ['short', 'has space 12345', 'x'.repeat(129), 'bad/slash1234', ''])
    assert.throws(() => parseIdempotencyKey(bad), /Idempotency-Key/);
  assert.throws(() => parseIdempotencyKey(['aaaaaaaa', 'bbbbbbbb']), /at most once/);

  const id = idempotentWorkflowExecutionId('ws_1', 'alice', KEY);
  assert.match(id, /^wfx_[0-9a-f]{32}$/);
  assert.equal(id, idempotentWorkflowExecutionId('ws_1', 'alice', KEY));
  assert.notEqual(id, idempotentWorkflowExecutionId('ws_1', 'bob', KEY), 'scoped to the principal');
  assert.notEqual(id, idempotentWorkflowExecutionId('ws_2', 'alice', KEY), 'scoped to the workspace');
  assert.notEqual(id, idempotentWorkflowExecutionId('ws_1', 'alice', KEY + '2'));

  const rec = {
    compilationId: 'c',
    workflowId: 'w',
    input: { a: 1, b: { x: 1, y: 2 } },
    createdAt: new Date().toISOString(),
    workflowExecutionId: id,
  } as never;
  assert.doesNotThrow(
    () => assertLegitimateReplay(rec, { compilationId: 'c', workflowId: 'w', input: { b: { y: 2, x: 1 }, a: 1 } }),
    'key order does not matter',
  );
  assert.throws(
    () => assertLegitimateReplay(rec, { compilationId: 'c', workflowId: 'w', input: { a: 2, b: { x: 1, y: 2 } } }),
    /different start request/,
  );
  assert.throws(
    () => assertLegitimateReplay(rec, { compilationId: 'c2', workflowId: 'w', input: { a: 1, b: { x: 1, y: 2 } } }),
    /different start request/,
  );
  assert.throws(
    () => assertLegitimateReplay(rec, { compilationId: 'c', workflowId: 'w2', input: { a: 1, b: { x: 1, y: 2 } } }),
    /different start request/,
  );
  const old = Date.now() + IDEMPOTENCY_WINDOW_MS + 1000;
  assert.throws(
    () => assertLegitimateReplay(rec, { compilationId: 'c', workflowId: 'w', input: { a: 1, b: { x: 1, y: 2 } } }, old),
    /24 hour/,
  );
});

test('idempotency: the same key and request returns the ORIGINAL run (200, replay header) and creates nothing', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const first = await start(env, KEY);
    assert.equal(first.status, 201, first.bodyText);
    assert.equal(first.headers['idempotent-replayed'], undefined);
    const run = first.json<RunWire>();
    const execsAfterFirst = await execCount(env);

    const again = await start(env, KEY);
    assert.equal(again.status, 200, again.bodyText);
    assert.equal(again.headers['idempotent-replayed'], 'true');
    assert.equal(again.json<RunWire>().workflowExecutionId, run.workflowExecutionId);
    assert.equal(again.json<RunWire>().revision, run.revision, 'untouched run, same state');

    assert.equal((await runs(env)).length, 1, 'no second run');
    assert.equal(await execCount(env), execsAfterFirst, 'no step was executed again');
  });
});

test('idempotency: with no key, behaviour is unchanged — every start creates a distinct run', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const a = await start(env, undefined);
    const b = await start(env, undefined);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.json<RunWire>().workflowExecutionId, b.json<RunWire>().workflowExecutionId);
    assert.equal((await runs(env)).length, 2);
  });
});

test('idempotency: a different key is a different run', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const a = await start(env, KEY);
    const b = await start(env, KEY + '-other');
    assert.notEqual(a.json<RunWire>().workflowExecutionId, b.json<RunWire>().workflowExecutionId);
    assert.equal((await runs(env)).length, 2);
  });
});

test('idempotency: the same key with a DIFFERENT request is a 409 conflict, and nothing is created or changed', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const first = await start(env, KEY);
    const before = await runs(env);
    const other = await start(env, KEY, { screening_score: 10, settlement_amount: 1 });
    assert.equal(other.status, 409, other.bodyText);
    const e = other.json<ErrorWire>().error;
    assert.equal(e.code, 'XO_RUNTIME_SESSION_INVALID_STATE');
    assert.equal(e.context?.['reason'], 'idempotency_key_reused');
    assert.deepEqual(await runs(env), before);
    assert.equal(first.json<RunWire>().workflowExecutionId, before[0]!.workflowExecutionId);
  });
});

test('idempotency: keys are scoped to the authenticated principal — another identity with the same key gets its own run', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const mine = await start(env, KEY);
    const other = await env.server.issueAdditionalIdentity('someone-else');
    // the other identity does not own this workspace: it is refused, and cannot observe or replay my key
    const theirs = await start(env, KEY, INPUT, env.server, TestServer.authHeader(other.apiKey));
    assert.ok(theirs.status === 404 || theirs.status === 403, theirs.bodyText);
    assert.equal(mine.status, 201);
    assert.equal((await runs(env)).length, 1);
  });
});

test('idempotency: concurrent requests with one key yield exactly one run', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const results = await Promise.all(Array.from({ length: 6 }, () => start(env, KEY)));
    const created = results.filter((r) => r.status === 201);
    const replayed = results.filter((r) => r.status === 200);
    assert.equal(created.length, 1, results.map((r) => r.status).join(','));
    assert.equal(replayed.length, 5);
    const ids = new Set(results.map((r) => r.json<RunWire>().workflowExecutionId));
    assert.equal(ids.size, 1);
    assert.equal((await runs(env)).length, 1);
    // the original run was not disturbed by the replays (still waiting at its human step, not "interrupted")
    assert.equal((await runs(env))[0]!.status, 'waiting_for_human');
  });
});

test('idempotency: durable — a retry after the API process restarts still finds the original run', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const first = await start(env, KEY);
    const id = first.json<RunWire>().workflowExecutionId;
    const restarted = await TestServer.start({ workspaceDataDir: env.dataDir, workspacesDir: env.workspacesDir }, env.server.identityId);
    try {
      const again = await start(env, KEY, INPUT, restarted);
      assert.equal(again.status, 200, again.bodyText);
      assert.equal(again.json<RunWire>().workflowExecutionId, id);
      assert.equal((await runs(env)).length, 1);
    } finally {
      await restarted.stop();
    }
  });
});

test("idempotency: a replay returns the run's CURRENT state, not a stale snapshot", async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const first = (await start(env, KEY)).json<RunWire>();
    const resumed = await env.server.request('POST', ws(env, `/workflow-executions/${first.workflowExecutionId}/resume`), {
      decision: 'approve',
      expectedStepExecutionId: first.currentStepExecutionId,
      expectedRevision: first.revision,
    });
    assert.equal(resumed.status, 200, resumed.bodyText);
    const again = await start(env, KEY);
    assert.equal(again.status, 200);
    assert.ok(again.json<RunWire>().revision > first.revision);
    assert.equal(again.json<RunWire>().workflowExecutionId, first.workflowExecutionId);
  });
});

test('idempotency: a key older than the 24h window is refused with 409 — never a new run, never a fake replay', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const run = (await start(env, KEY)).json<RunWire>();
    const file = join(env.dataDir, env.workspace.workspaceId, 'workflow-executions', run.workflowExecutionId, 'metadata.json');
    const rec = JSON.parse(await readFile(file, 'utf8')) as { createdAt: string };
    rec.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await writeFile(file, JSON.stringify(rec));
    const late = await start(env, KEY);
    assert.equal(late.status, 409, late.bodyText);
    assert.equal(late.json<ErrorWire>().error.context?.['reason'], 'idempotency_key_expired');
    assert.equal((await runs(env)).length, 1);
    // a NEW key starts a new run
    assert.equal((await start(env, KEY + '-new')).status, 201);
  });
});

test('idempotency: authorization is checked on EVERY request — a replay is not a bypass', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    assert.equal((await start(env, KEY)).status, 201);
    // remove every approval in this workspace, then replay
    const wsDir = join(env.dataDir, env.workspace.workspaceId);
    for (const name of await readdir(wsDir)) if (/approval/i.test(name)) await rm(join(wsDir, name), { recursive: true, force: true });
    const replay = await start(env, KEY);
    assert.equal(replay.status, 403, replay.bodyText);
    assert.equal((await runs(env)).length, 1);
  });
});

test('idempotency: a refused or invalid start does not consume the key, and creates nothing', async () => {
  await withEnv(async (env) => {
    // not approved yet -> 403
    const denied = await start(env, KEY);
    assert.equal(denied.status, 403);
    assert.equal((await runs(env)).length, 0);
    await approveChain(env);
    // invalid input -> 400
    const bad = await start(env, KEY, { not_a_field_any_step_accepts: 1 });
    assert.equal(bad.status, 400, bad.bodyText);
    assert.equal((await runs(env)).length, 0);
    // the same key still works for a valid request
    const ok = await start(env, KEY);
    assert.equal(ok.status, 201, ok.bodyText);
    assert.equal((await runs(env)).length, 1);
  });
});

test('idempotency: a malformed Idempotency-Key is a 400 and creates nothing', async () => {
  await withEnv(async (env) => {
    await approveChain(env);
    const res = await start(env, 'short');
    assert.equal(res.status, 400, res.bodyText);
    assert.equal(res.json<ErrorWire>().error.context?.['reason'], 'idempotency_key_invalid');
    assert.equal((await runs(env)).length, 0);
  });
});
