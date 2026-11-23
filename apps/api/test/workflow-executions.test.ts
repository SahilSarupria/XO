import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { FsWorkflowExecutionStore, mintWorkflowExecutionId } from '../src/workflows/fs-workflow-execution-store.js';
import { StaleWorkflowRevisionError } from '../src/workflows/workflow-execution.js';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
function asAuthenticated(id: string) {
  const p = establishAuthenticatedPrincipal({ kind: 'service', id });
  if (!p.ok) throw p.error;
  return p.value;
}

// ---------------------------------------------------------------------------
// Wire shapes (only what these tests read)
// ---------------------------------------------------------------------------

interface WorkflowViewWire {
  readonly workflowId: string;
  readonly compilationId: string;
  readonly status: string;
  readonly executable: boolean;
  readonly notExecutableReasons: readonly string[];
  readonly steps: readonly {
    readonly order: number;
    readonly capabilityId: string;
    readonly executionClass?: string;
    readonly bound: boolean;
    readonly approved: boolean;
  }[];
  readonly dataFlow: {
    readonly provenBindings: readonly {
      readonly producerCapabilityId: string;
      readonly outputParameterName: string;
      readonly consumerCapabilityId: string;
      readonly inputParameterName: string;
      readonly wired: boolean;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Harness: real HTTP server + real filesystem stores in temp dirs
// ---------------------------------------------------------------------------

interface Env {
  readonly dataDir: string;
  readonly workspacesDir: string;
  server: TestServer;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-p08-data-', async (dataDir) => {
    await withTempDir('xo-p08-ws-', async (workspacesDir) => {
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

async function approve(env: Env, capabilityId: string, compilationId = env.compilationId): Promise<void> {
  const res = await env.server.request('POST', ws(env, `/compilations/${compilationId}/capabilities/${capabilityId}/approve`));
  assert.ok(res.status === 200 || res.status === 201, `approve ${capabilityId} -> ${res.status} ${res.bodyText}`);
}

// ---------------------------------------------------------------------------
// 1. Discovery
// ---------------------------------------------------------------------------

test('discovery: GET /workflows exposes every workflow composed from the stored compilation with its verbatim executability status, ordered steps, and proven-binding evidence', async () => {
  await withEnv(async (env) => {
    const res = await env.server.request('GET', ws(env, '/workflows'));
    assert.equal(res.status, 200);
    const { workflows } = res.json<{ workflows: WorkflowViewWire[] }>();
    assert.equal(workflows.length, 7);
    for (const w of workflows) assert.equal(w.compilationId, env.compilationId);

    const byFirst = (id: string) => workflows.find((w) => w.steps[0]?.capabilityId === id)!;

    const flow = byFirst(IDS.flowA);
    assert.equal(flow.status, 'executable_candidate');
    assert.equal(flow.executable, true);
    assert.deepEqual(
      flow.steps.map((s) => [s.order, s.capabilityId, s.executionClass, s.bound, s.approved]),
      [
        [0, IDS.flowA, 'deterministic_rule', true, false],
        [1, IDS.flowB, 'deterministic_rule', true, false],
      ],
    );
    assert.deepEqual(flow.dataFlow.provenBindings, [
      {
        producerCapabilityId: IDS.flowA,
        outputParameterName: 'matched',
        consumerCapabilityId: IDS.flowB,
        inputParameterName: 'matched',
        wired: true,
      },
    ]);

    const chain = byFirst(IDS.hitlA);
    assert.deepEqual(
      chain.steps.map((s) => [s.capabilityId, s.executionClass]),
      [
        [IDS.hitlA, 'deterministic_rule'],
        [IDS.hitlB, 'human_in_the_loop'],
        [IDS.hitlC, 'deterministic_rule'],
      ],
    );

    // Statuses are preserved verbatim, never upgraded.
    assert.equal(byFirst(IDS.orphan).status, 'not_executable_yet');
    assert.equal(byFirst(IDS.orphan).executable, false);
    assert.ok(byFirst(IDS.orphan).notExecutableReasons.length > 0);
    assert.equal(byFirst(IDS.cycleX).status, 'semantically_invalid');
    assert.equal(byFirst(IDS.cycleX).executable, false);

    // approval state is reflected per step
    await approve(env, IDS.flowA);
    const after = (await env.server.request('GET', ws(env, '/workflows'))).json<{ workflows: WorkflowViewWire[] }>().workflows;
    assert.deepEqual(
      after.find((w) => w.steps[0]?.capabilityId === IDS.flowA)!.steps.map((s) => s.approved),
      [true, false],
    );

    // filter + 404 + auth
    const filtered = await env.server.request('GET', ws(env, `/workflows?compilationId=${env.compilationId}`));
    assert.equal(filtered.json<{ workflows: unknown[] }>().workflows.length, 7);
    assert.equal((await env.server.request('GET', ws(env, '/workflows?compilationId=comp_doesnotexist'))).status, 404);
    assert.equal((await env.server.request('GET', ws(env, '/workflows'), undefined, {}, { skipAuth: true })).status, 401);
  });
});

// ---------------------------------------------------------------------------
// 2, 5, 6, 7, 8 — deterministic multi-step workflow with proven data flow
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3, 4 — non-executable workflows
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10, 11, 9 — HITL pauses the workflow at the HITL step
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 13, 14, 15, 9 — approve resumes the right step; A is not re-run; C runs; final result persisted
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 16 — rejection
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 17, 18, 19 — concurrency / stale-state protection
// ---------------------------------------------------------------------------

test('FsWorkflowExecutionStore.save is compare-and-swap: a stale expected revision fails and leaves the newer stored state untouched', async () => {
  await withTempDir('xo-p08-store-', async (dir) => {
    const store = new FsWorkflowExecutionStore(new LocalFsBlobStore(dir));
    const id = mintWorkflowExecutionId();
    const created = await store.create('ws_x', asAuthenticated('ident_x'), {
      workflowExecutionId: id,
      compilationId: 'comp_x',
      workflowId: 'wf_x',
      workflowName: 'x',
      input: {},
      steps: [{ stepId: 's#0', order: 0, capabilityId: 'cap_x', capabilityName: 'x' }],
    });
    assert.ok(created.ok);
    assert.equal(created.value.revision, 0);

    const v1 = await store.save({ ...created.value, revision: 1, status: 'running' }, 0);
    assert.ok(v1.ok);
    // a writer still holding revision 0 now tries to overwrite
    const stale = await store.save({ ...created.value, revision: 1, status: 'failed', errorCode: 'X' }, 0);
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.ok(stale.error instanceof StaleWorkflowRevisionError);
      assert.equal((stale.error as StaleWorkflowRevisionError).expectedRevision, 0);
      assert.equal((stale.error as StaleWorkflowRevisionError).actualRevision, 1);
    }
    const stored = await store.get(id);
    assert.ok(stored.ok);
    assert.equal(stored.value.status, 'running');
    assert.equal(stored.value.revision, 1);
    // a mis-numbered next revision is refused outright
    const bad = await store.save({ ...v1.value, revision: 5 }, 1);
    assert.equal(bad.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 12, 24 — restart and recovery (real filesystem, second server instance on the same directories)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 20, 21 — cross-workspace isolation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 22 — the client cannot control the plan
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 23 — permissions / approval, at start AND before every step
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Real-fixture customer-value demo: Commercial Property PDF, end to end over the API
// ---------------------------------------------------------------------------
