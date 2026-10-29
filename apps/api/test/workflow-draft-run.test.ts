import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

interface RunWire {
  readonly workflowExecutionId: string;
  readonly workflowId: string;
  readonly status: string;
  readonly compilationId: string;
  readonly draft?: {
    definitionId: string;
    revision: number;
    path: string[];
    branches: { nodeId: string; taken: string; value: number; basis: string }[];
  };
  readonly steps: readonly { capabilityId: string; status: string; executionId?: string }[];
  readonly pendingHumanTask?: { executionId: string };
}
interface DraftWire {
  definitionId: string;
  revision: number;
  analysis: {
    runnable: boolean;
    wellFormed: boolean;
    errors: { message: string }[];
    blockers: { nodeId?: string; message: string }[];
    plan?: {
      compilationId: string;
      path: string[];
      steps: { capabilityId: string; executionClass: string; approved: boolean }[];
      branches: { taken: string; value: number }[];
    };
  };
}

interface Env {
  server: TestServer;
  workspace: WorkspaceRecord;
  compilationId: string;
  drafts: string;
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-draft-data-', async (dataDir) =>
    withTempDir('xo-draft-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        await fn({ server, workspace, compilationId, drafts: `/workspaces/${workspace.workspaceId}/workflow-definitions` });
      } finally {
        await server.stop();
      }
    }),
  );
}

const ws = (env: Env, suffix: string) => `/workspaces/${env.workspace.workspaceId}${suffix}`;
const cap = (env: Env, id: string, capabilityId: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'capability',
  config: { packageName: 'fixture', capabilityId, memoryScope: 'none', compilationId: env.compilationId, ...extra },
});
const manual = { id: 'start', kind: 'trigger', config: { type: 'manual' } };

async function save(env: Env, body: unknown): Promise<DraftWire> {
  const res = await env.server.request('POST', env.drafts, body);
  assert.equal(res.status, 201, res.bodyText);
  return res.json<DraftWire>();
}
async function approve(env: Env, capabilityId: string): Promise<void> {
  const res = await env.server.request('POST', ws(env, `/compilations/${env.compilationId}/capabilities/${capabilityId}/approve`));
  assert.ok(res.status === 200 || res.status === 201, res.bodyText);
}
const runs = async (env: Env) =>
  (await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: RunWire[] }>().workflowExecutions;

const flowDraft = (env: Env) => ({
  name: 'flow',
  nodes: [manual, cap(env, 'a', IDS.flowA), cap(env, 'b', IDS.flowB)],
  edges: [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'b' },
  ],
});
const FLOW_INPUT = { claim_amount: 15000, payout_amount: 800 };

test('analysis resolves the plan from the stored compilation and says runnable only then', async () => {
  await withEnv(async (env) => {
    const ok = await save(env, flowDraft(env));
    assert.equal(ok.analysis.runnable, true, JSON.stringify(ok.analysis));
    assert.deepEqual(
      ok.analysis.plan?.steps.map((s) => [s.capabilityId, s.executionClass, s.approved]),
      [
        [IDS.flowA, 'deterministic_rule', false],
        [IDS.flowB, 'deterministic_rule', false],
      ],
    );
    assert.equal(ok.analysis.plan?.compilationId, env.compilationId);

    const noCompilation = await save(env, {
      ...flowDraft(env),
      nodes: [
        manual,
        { ...cap(env, 'a', IDS.flowA), config: { packageName: 'p', capabilityId: IDS.flowA, memoryScope: 'none' } },
        cap(env, 'b', IDS.flowB),
      ],
    });
    assert.equal(noCompilation.analysis.runnable, false);
    assert.match(noCompilation.analysis.blockers.map((b) => b.message).join('|'), /does not say which compilation/);

    const unknown = await save(env, {
      ...flowDraft(env),
      nodes: [manual, cap(env, 'a', IDS.flowA, { compilationId: 'cmp_nope' }), cap(env, 'b', IDS.flowB, { compilationId: 'cmp_nope' })],
    });
    assert.match(unknown.analysis.blockers.map((b) => b.message).join('|'), /it does not exist in this workspace/);

    const unboundCap = await save(env, { ...flowDraft(env), nodes: [manual, cap(env, 'a', IDS.orphan), cap(env, 'b', IDS.flowB)] });
    assert.equal(unboundCap.analysis.runnable, false);

    const missingCap = await save(env, {
      ...flowDraft(env),
      nodes: [manual, cap(env, 'a', 'cap_does_not_exist'), cap(env, 'b', IDS.flowB)],
    });
    assert.match(missingCap.analysis.blockers.map((b) => b.message).join('|'), /does not exist in compilation/);
  });
});

test('unsupported shapes keep their blockers and POST /run answers 501 with the analysis, creating nothing', async () => {
  await withEnv(async (env) => {
    const sched = await save(env, {
      ...flowDraft(env),
      nodes: [{ id: 'start', kind: 'trigger', config: { type: 'schedule' } }, cap(env, 'a', IDS.flowA), cap(env, 'b', IDS.flowB)],
    });
    const email = await save(env, {
      ...flowDraft(env),
      nodes: [...flowDraft(env).nodes, { id: 'mail', kind: 'action', config: { type: 'email' } }],
      edges: [...flowDraft(env).edges, { from: 'b', to: 'mail' }],
    });
    const memory = await save(env, {
      ...flowDraft(env),
      nodes: [manual, cap(env, 'a', IDS.flowA, { memoryScope: 'workspace' }), cap(env, 'b', IDS.flowB)],
    });
    const standaloneReview = await save(env, {
      ...flowDraft(env),
      nodes: [...flowDraft(env).nodes, { id: 'rev', kind: 'human_review', config: {} }],
      edges: [...flowDraft(env).edges, { from: 'b', to: 'rev' }],
    });
    const joinless = await save(env, {
      name: 'fan-out',
      nodes: [manual, cap(env, 'a', IDS.flowA), cap(env, 'b', IDS.flowB)],
      edges: [
        { from: 'start', to: 'a' },
        { from: 'start', to: 'b' },
      ],
    });
    for (const [d, re] of [
      [sched, /no scheduler/],
      [email, /no email delivery/],
      [memory, /memory scopes/],
      [standaloneReview, /review step can only follow/],
      [joinless, /parallel paths/],
    ] as const) {
      assert.equal(d.analysis.runnable, false);
      assert.match(d.analysis.blockers.map((b) => b.message).join('|'), re);
      const res = await env.server.request('POST', `${env.drafts}/${d.definitionId}/run`, {});
      assert.equal(res.status, 501, res.bodyText);
      assert.equal(res.json<{ analysis: DraftWire['analysis'] }>().analysis.runnable, false);
    }
    assert.equal((await runs(env)).length, 0);
    assert.equal((await env.server.request('POST', `${env.drafts}/wfd_${'0'.repeat(32)}/run`, {})).status, 404);
  });
});

test('a runnable draft goes through the same approval gate: 403 before approval, 202 and a real recorded run after', async () => {
  await withEnv(async (env) => {
    const d = await save(env, flowDraft(env));
    const denied = await env.server.request('POST', `${env.drafts}/${d.definitionId}/run`, { input: FLOW_INPUT });
    assert.equal(denied.status, 403, denied.bodyText);
    assert.equal((await runs(env)).length, 0);

    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const bad = await env.server.request('POST', `${env.drafts}/${d.definitionId}/run`, { input: { claim_amount: 'lots' } });
    assert.equal(bad.status, 400, bad.bodyText);
    assert.equal((await runs(env)).length, 0);

    const res = await env.server.request('POST', `${env.drafts}/${d.definitionId}/run`, {
      input: FLOW_INPUT,
      expectedRevision: d.revision,
    });
    assert.equal(res.status, 202, res.bodyText);
    const run = res.json<RunWire>();
    assert.equal(run.status, 'succeeded');
    assert.equal(run.workflowId, `draft:${d.definitionId}`);
    assert.equal(run.compilationId, env.compilationId);
    assert.deepEqual(
      run.steps.map((s) => [s.capabilityId, s.status]),
      [
        [IDS.flowA, 'succeeded'],
        [IDS.flowB, 'succeeded'],
      ],
    );
    assert.deepEqual(run.draft?.path, ['start', 'a', 'b']);
    assert.equal(run.draft?.revision, d.revision);
    // each step is a real recorded execution
    for (const s of run.steps) assert.equal((await env.server.request('GET', ws(env, `/executions/${s.executionId}`))).status, 200);
    // visible through the ordinary run listing and audited
    assert.equal((await runs(env)).length, 1);
    const events = (await env.server.request('GET', ws(env, '/audit/events?event=workflow.started'))).json<{
      events: { detail?: Record<string, unknown> }[];
    }>().events;
    assert.ok(events.some((e) => e.detail?.['draftId'] === d.definitionId && e.detail?.['draftRevision'] === d.revision));
  });
});

test('a human-in-the-loop capability opens a human task through the existing path and the ordinary resume finishes the run', async () => {
  await withEnv(async (env) => {
    for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) await approve(env, id);
    const d = await save(env, {
      name: 'hitl',
      nodes: [
        manual,
        cap(env, 'a', IDS.hitlA),
        cap(env, 'b', IDS.hitlB),
        { id: 'rev', kind: 'human_review', config: {} },
        cap(env, 'c', IDS.hitlC),
      ],
      edges: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'rev' },
        { from: 'rev', to: 'c' },
      ],
    });
    assert.equal(d.analysis.runnable, true, JSON.stringify(d.analysis));
    const started = await env.server.request('POST', `${env.drafts}/${d.definitionId}/run`, {
      input: { screening_score: 90, settlement_amount: 800 },
    });
    assert.equal(started.status, 202, started.bodyText);
    const waiting = started.json<RunWire>();
    assert.equal(waiting.status, 'waiting_for_human');
    assert.ok(waiting.pendingHumanTask);
    const resumed = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), {
      decision: 'approve',
      expectedStepExecutionId: waiting.pendingHumanTask!.executionId,
    });
    assert.equal(resumed.status, 200, resumed.bodyText);
    assert.equal(resumed.json<RunWire>().status, 'succeeded');
    assert.deepEqual(
      resumed.json<RunWire>().steps.map((s) => s.status),
      ['succeeded', 'succeeded', 'succeeded'],
    );
  });
});

test("a confidence branch takes the side the capability's declared confidence selects, and records why", async () => {
  await withEnv(async (env) => {
    for (const id of [IDS.flowA, IDS.flowB, IDS.hitlA]) await approve(env, id);
    const branchDraft = (threshold: number) => ({
      name: `branch-${threshold}`,
      nodes: [
        manual,
        cap(env, 'a', IDS.flowA),
        { id: 'gate', kind: 'branch', config: { metric: 'confidence', threshold } },
        cap(env, 'hi', IDS.flowB),
        cap(env, 'lo', IDS.hitlA),
      ],
      edges: [
        { from: 'start', to: 'a' },
        { from: 'a', to: 'gate' },
        { from: 'gate', to: 'hi', when: 'gte' },
        { from: 'gate', to: 'lo', when: 'lt' },
      ],
    });
    const low = await save(env, branchDraft(0.01));
    const high = await save(env, branchDraft(0.999));
    assert.equal(low.analysis.plan?.branches[0]?.taken, 'gte');
    assert.equal(high.analysis.plan?.branches[0]?.taken, 'lt');
    const lowInput = FLOW_INPUT;
    const highInput = { claim_amount: 15000, screening_score: 90 };
    const ra = await env.server.request('POST', `${env.drafts}/${low.definitionId}/run`, { input: lowInput });
    assert.equal(ra.status, 202, ra.bodyText);
    const a = ra.json<RunWire>();
    assert.deepEqual(
      a.steps.map((s) => s.capabilityId),
      [IDS.flowA, IDS.flowB],
    );
    assert.equal(a.draft?.branches[0]?.taken, 'gte');
    assert.equal(a.draft?.branches[0]?.basis, 'declared_contract_confidence');
    const rb = await env.server.request('POST', `${env.drafts}/${high.definitionId}/run`, { input: highInput });
    assert.equal(rb.status, 202, rb.bodyText);
    const b = rb.json<RunWire>();
    assert.deepEqual(
      b.steps.map((s) => s.capabilityId),
      [IDS.flowA, IDS.hitlA],
    );
    assert.equal(b.draft?.branches[0]?.taken, 'lt');
  });
});

test('run request validation: stale revision is refused, unknown fields are refused, branch must follow a capability', async () => {
  await withEnv(async (env) => {
    const d = await save(env, flowDraft(env));
    const stale = await env.server.request('POST', `${env.drafts}/${d.definitionId}/run`, { expectedRevision: d.revision + 1 });
    assert.equal(stale.status, 409, stale.bodyText);
    const unknown = await env.server.request('POST', `${env.drafts}/${d.definitionId}/run`, { steps: [] });
    assert.equal(unknown.status, 400);
    const orphanBranch = await save(env, {
      name: 'bad-branch',
      nodes: [
        manual,
        { id: 'gate', kind: 'branch', config: { metric: 'confidence', threshold: 0.5 } },
        cap(env, 'x', IDS.flowA),
        cap(env, 'y', IDS.flowB),
      ],
      edges: [
        { from: 'start', to: 'gate' },
        { from: 'gate', to: 'x', when: 'gte' },
        { from: 'gate', to: 'y', when: 'lt' },
      ],
    });
    assert.equal(orphanBranch.analysis.runnable, false);
    assert.match(orphanBranch.analysis.blockers.map((b) => b.message).join('|'), /branch must come directly after a capability/);
    assert.equal((await runs(env)).length, 0);
  });
});
