import { PackageTrustPolicy } from '@xo/package-sdk';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { NonProductionAuditSink } from '@xo/audit';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { AuditService } from '../src/audit/audit-service.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { LocalFsBlobStore } from '@xo/storage';
import {
  contentHash,
  defaultDeployment,
  evaluateReadiness,
  evaluateStartGate,
  NOT_PAUSED,
  parseDailyCap,
  parseEveryMinutes,
  scheduleDue,
  summarizeShadow,
  transitionRefusal,
  type Deployment,
} from '../src/workflow-controls/model.js';
import { runDueSchedules } from '../src/workflow-controls/scheduler.js';

// ------------------------------------------------------------------ pure rules
const NOW = new Date('2026-11-03T12:00:00Z');
const dep = (over: Partial<Deployment> = {}): Deployment => ({ ...defaultDeployment('c1', 'w1', NOW.toISOString()), ...over });
const view = {
  compilationId: 'c1',
  workflowId: 'w1',
  steps: [
    { order: 0, capabilityId: 'a' },
    { order: 1, capabilityId: 'b' },
  ],
};

test('readiness: every item says what is true or missing, and a changed workflow makes a sign-off stale', () => {
  const hash = contentHash(view);
  const all = evaluateReadiness({
    executable: true,
    steps: [{ approved: true }, { approved: true }],
    deployment: dep({ limits: { dailyRunCap: 5 }, signOff: { identityId: 'r', at: 'x', contentHash: hash } }),
    currentHash: hash,
    shadowRuns: 2,
  });
  assert.deepEqual(
    all.map((i) => [i.id, i.ok]),
    [
      ['rules', true],
      ['runnable', true],
      ['signed', true],
      ['limits', true],
      ['practice', true],
    ],
  );
  assert.equal(transitionRefusal('live', all), undefined);

  const stale = evaluateReadiness({
    executable: true,
    steps: [{ approved: true }],
    deployment: dep({ signOff: { identityId: 'r', at: 'x', contentHash: hash } }),
    currentHash: contentHash({ ...view, steps: [...view.steps, { order: 2, capabilityId: 'c' }] }),
    shadowRuns: 0,
  });
  assert.equal(stale.find((i) => i.id === 'signed')?.ok, false);
  assert.match(stale.find((i) => i.id === 'signed')!.message, /changed since it was signed off/);
  const refusal = transitionRefusal('live', stale)!;
  assert.equal(refusal.reason, 'not_ready');
  assert.match(refusal.message, /signed off/);
  assert.match(refusal.message, /daily limit/);
  assert.match(refusal.message, /not practised/);
});

test('transitions: practising needs approved rules and a runnable workflow; draft and paused are always allowed', () => {
  const none = evaluateReadiness({ executable: false, steps: [{ approved: false }], deployment: dep(), currentHash: 'h', shadowRuns: 0 });
  assert.ok(transitionRefusal('shadow', none));
  assert.equal(transitionRefusal('draft', none), undefined);
  assert.equal(transitionRefusal('paused', none), undefined);
  const noSteps = evaluateReadiness({ executable: true, steps: [], deployment: dep(), currentHash: 'h', shadowRuns: 0 });
  assert.equal(noSteps.find((i) => i.id === 'rules')?.ok, false, 'a workflow with no steps is not "all approved"');
});

test('the start gate refuses, in order: workspace pause, workflow pause, an inactive trigger, the daily limit', () => {
  const g = (d: Deployment, trigger: 'manual' | 'webhook' | 'schedule', runsToday = 0, paused = false) =>
    evaluateStartGate({ controls: paused ? { paused: true, revision: 1 } : NOT_PAUSED, deployment: d, trigger, runsToday });
  assert.deepEqual(g(dep(), 'manual'), { allowed: true, shadow: false });
  assert.equal((g(dep({ mode: 'live' }), 'manual', 0, true) as { reason: string }).reason, 'workspace_paused');
  assert.equal((g(dep({ mode: 'paused' }), 'manual') as { reason: string }).reason, 'workflow_paused');
  // Triggers fire only when switched on AND practising or live; manual starts do not need either.
  assert.equal((g(dep({ mode: 'live' }), 'webhook') as { reason: string }).reason, 'trigger_inactive');
  assert.equal((g(dep({ mode: 'draft', triggers: { webhook: true } }), 'webhook') as { reason: string }).reason, 'trigger_inactive');
  assert.deepEqual(g(dep({ mode: 'live', triggers: { webhook: true } }), 'webhook'), { allowed: true, shadow: false });
  assert.deepEqual(g(dep({ mode: 'shadow', triggers: { webhook: true } }), 'webhook'), { allowed: true, shadow: true });
  assert.equal((g(dep({ limits: { dailyRunCap: 3 } }), 'manual', 3) as { reason: string }).reason, 'daily_cap_reached');
  assert.equal(g(dep({ limits: { dailyRunCap: 3 } }), 'manual', 2).allowed, true);
});

test('schedule timing: due after a full interval, never in draft or paused, never for a missing schedule', () => {
  const sched = { everyMinutes: 10, lastFiredAt: '2026-11-03T11:50:00Z' };
  assert.equal(scheduleDue(dep({ mode: 'live', triggers: { webhook: false, schedule: sched } }), NOW), true);
  assert.equal(
    scheduleDue(dep({ mode: 'live', triggers: { webhook: false, schedule: { ...sched, lastFiredAt: '2026-11-03T11:55:01Z' } } }), NOW),
    false,
  );
  assert.equal(scheduleDue(dep({ mode: 'draft', triggers: { webhook: false, schedule: sched } }), NOW), false);
  assert.equal(scheduleDue(dep({ mode: 'paused', triggers: { webhook: false, schedule: sched } }), NOW), false);
  assert.equal(scheduleDue(dep({ mode: 'live' }), NOW), false);
});

test('shadow summary counts what practice runs did and how often a reviewer agreed, and nothing else', () => {
  const runs = [
    { workflowExecutionId: 'a', status: 'succeeded', shadow: { outcome: 'would_complete' as const } },
    { workflowExecutionId: 'b', status: 'succeeded', shadow: { outcome: 'would_escalate' as const } },
    { workflowExecutionId: 'c', status: 'succeeded', shadow: {} }, // a practice run that never needed a person
    { workflowExecutionId: 'd', status: 'succeeded' }, // not a practice run
  ];
  const s = summarizeShadow(runs, { a: 'automatic', b: 'automatic', c: 'person', zzz: 'person' });
  assert.deepEqual(s, { runs: 3, wouldComplete: 2, wouldEscalate: 1, reviewed: 3, agreed: 1 });
  assert.deepEqual(summarizeShadow([], {}), { runs: 0, wouldComplete: 0, wouldEscalate: 0, reviewed: 0, agreed: 0 });
});

test('input validation: the daily cap and the schedule interval are whole numbers inside fixed bounds', () => {
  for (const bad of [0, -1, 1.5, '5', NaN, 100_001, undefined, {}]) assert.equal(parseDailyCap(bad), 'invalid', String(bad));
  assert.equal(parseDailyCap(null), undefined);
  assert.equal(parseDailyCap(100_000), 100_000);
  for (const bad of [4, 10_081, 5.5, '10', null, undefined]) assert.equal(parseEveryMinutes(bad), 'invalid', String(bad));
  assert.equal(parseEveryMinutes(5), 5);
  assert.equal(parseEveryMinutes(10_080), 10_080);
});

// ------------------------------------------------------------------ over HTTP
interface Env {
  dataDir: string;
  workspacesDir: string;
  server: TestServer;
  workspace: WorkspaceRecord;
  compilationId: string;
}
async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-ctl-data-', async (dataDir) => {
    await withTempDir('xo-ctl-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        await fn({ dataDir, workspacesDir, server, workspace, compilationId });
      } finally {
        await server.stop();
      }
    });
  });
}
const ws = (e: Env, s: string) => `/workspaces/${e.workspace.workspaceId}${s}`;
async function approve(e: Env, ...ids: string[]) {
  for (const id of ids)
    assert.ok(
      [200, 201].includes((await e.server.request('POST', ws(e, `/compilations/${e.compilationId}/capabilities/${id}/approve`))).status),
    );
}
async function workflowId(e: Env, first: string): Promise<string> {
  const r = (await e.server.request('GET', ws(e, '/workflows'))).json<{
    workflows: { workflowId: string; steps: { capabilityId: string }[] }[];
  }>();
  return r.workflows.find((w) => w.steps[0]?.capabilityId === first)!.workflowId;
}
const flowIn = { claim_amount: 15000, payout_amount: 800 };
const hitlIn = { screening_score: 90, settlement_amount: 800 };
interface Dep {
  mode: string;
  triggers: { webhook: boolean; schedule?: { everyMinutes: number; lastOutcome?: string } };
  limits: { dailyRunCap?: number; runsToday: number };
  signOff?: { identityId: string; current: boolean };
  readiness: { id: string; ok: boolean; message: string }[];
  canGoLive: boolean;
  shadow: { runs: number; wouldComplete: number; wouldEscalate: number; reviewed: number; agreed: number };
  shadowCases: { workflowExecutionId: string; outcome: string; stepName?: string; judgement?: string }[];
}
const ctl = (e: Env, id: string, action: string) => ws(e, `/workflow-controls/workflows/${id}/${action}`);
async function addMember(e: Env, identityId: string, role: string) {
  const r = await e.server.request('POST', ws(e, '/members'), { identityId, role });
  assert.ok(r.status === 200 || r.status === 201, r.bodyText);
  return (await e.server.issueAdditionalIdentity(identityId)).apiKey;
}

test('defaults: a workflow nobody touched is a draft with no triggers and no limit, and a manual start works exactly as before', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    const all = (await e.server.request('GET', ws(e, '/workflow-controls'))).json<{
      paused: boolean;
      deployments: (Dep & { workflowId: string })[];
    }>();
    assert.equal(all.paused, false);
    const d = all.deployments.find((x) => x.workflowId === wf)!;
    assert.equal(d.mode, 'draft');
    assert.deepEqual(d.triggers, { manual: true, webhook: false });
    assert.equal(d.limits.dailyRunCap, undefined);
    assert.equal(d.canGoLive, false);
    const run = await e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: flowIn });
    assert.equal(run.status, 201, run.bodyText);
    const body = run.json<{ status: string; shadow?: unknown; trigger?: unknown }>();
    assert.equal(body.status, 'succeeded');
    assert.equal(body.shadow, undefined);
    assert.equal(body.trigger, undefined);
  });
});

test('practice (shadow): carries out what XO can, stops before the first step that needs a person, and asks nobody', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.hitlA, IDS.hitlB, IDS.hitlC);
    const wf = await workflowId(e, IDS.hitlA);
    assert.equal((await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' })).status, 200);
    const res = await e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: hitlIn });
    assert.equal(res.status, 201, res.bodyText);
    const run = res.json<{
      status: string;
      currentStepIndex: number | null;
      pendingHumanTask?: unknown;
      steps: { status: string }[];
      shadow: { outcome: string; stepName?: string };
    }>();
    assert.equal(run.status, 'succeeded');
    assert.equal(run.shadow.outcome, 'would_escalate');
    assert.deepEqual(
      run.steps.map((s) => s.status),
      ['succeeded', 'skipped', 'skipped'],
    );
    assert.equal(run.pendingHumanTask, undefined);
    // Nobody was asked: only the first step has an execution, and no human task exists.
    const execs = (await e.server.request('GET', ws(e, '/executions'))).json<{ executions: { capabilityId: string }[] }>().executions;
    assert.deepEqual(
      execs.map((x) => x.capabilityId),
      [IDS.hitlA],
    );
    const d = (await e.server.request('GET', ws(e, '/workflow-controls')))
      .json<{ deployments: (Dep & { workflowId: string })[] }>()
      .deployments.find((x) => x.workflowId === wf)!;
    assert.equal(d.shadow.wouldEscalate, 1);
    assert.equal(d.shadowCases[0]?.outcome, 'would_escalate');
  });
});

test('practice on a workflow that needs no person finishes as "would complete"', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' });
    const run = (
      await e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: flowIn })
    ).json<{ status: string; shadow: { outcome: string } }>();
    assert.equal(run.status, 'succeeded');
    assert.equal(run.shadow.outcome, 'would_complete');
  });
});

test('going live needs every readiness item, publish for the mode, review for the sign-off, and each refusal says what is missing', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    const publisher = await addMember(e, 'pub', 'publisher');
    const reviewer = await addMember(e, 'rev', 'reviewer');
    const viewer = await addMember(e, 'view', 'viewer');
    const as = (key: string) => TestServer.authHeader(key);
    const live = { compilationId: e.compilationId, mode: 'live' };

    const early = await e.server.request('POST', ctl(e, wf, 'mode'), live, as(publisher));
    assert.equal(early.status, 412);
    assert.match(early.json<{ error: { message: string } }>().error.message, /signed this version off/);

    // Roles: a viewer and a reviewer cannot change the mode; a publisher cannot sign off.
    assert.equal(
      (await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'draft' }, as(viewer))).status,
      403,
    );
    assert.equal(
      (await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' }, as(reviewer))).status,
      403,
    );
    assert.equal((await e.server.request('POST', ctl(e, wf, 'sign-off'), { compilationId: e.compilationId }, as(publisher))).status, 403);
    assert.equal(
      (await e.server.request('PUT', ctl(e, wf, 'limits'), { compilationId: e.compilationId, dailyRunCap: 5 }, as(viewer))).status,
      403,
    );

    assert.equal(
      (await e.server.request('PUT', ctl(e, wf, 'limits'), { compilationId: e.compilationId, dailyRunCap: 5 }, as(publisher))).status,
      200,
    );
    const signed = await e.server.request('POST', ctl(e, wf, 'sign-off'), { compilationId: e.compilationId }, as(reviewer));
    assert.equal(signed.status, 200, signed.bodyText);
    assert.deepEqual(
      { id: signed.json<Dep>().signOff?.identityId, current: signed.json<Dep>().signOff?.current },
      { id: 'rev', current: true },
    );

    // Still not practised.
    const stillEarly = await e.server.request('POST', ctl(e, wf, 'mode'), live, as(publisher));
    assert.equal(stillEarly.status, 412);
    assert.match(stillEarly.json<{ error: { message: string } }>().error.message, /has not practised/);

    assert.equal(
      (await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' }, as(publisher))).status,
      200,
    );
    assert.equal(
      (
        await e.server.request(
          'POST',
          ws(e, `/workflows/${wf}/executions`),
          { compilationId: e.compilationId, input: flowIn },
          as(publisher),
        )
      ).status,
      201,
    );
    const ok = await e.server.request('POST', ctl(e, wf, 'mode'), live, as(publisher));
    assert.equal(ok.status, 200, ok.bodyText);
    assert.equal(ok.json<Dep>().mode, 'live');
    assert.equal(ok.json<Dep>().canGoLive, true);

    // An author-only change to live is not enough: publish is required (the reviewer lacks author AND publish).
    const audit = (await e.server.request('GET', ws(e, '/audit/events'))).json<{ events: { event: string; detail?: { to?: string } }[] }>();
    assert.ok(audit.events.some((x) => x.event === 'workflow.mode_changed' && x.detail?.to === 'live'));
    assert.ok(audit.events.some((x) => x.event === 'workflow.signed_off'));
    assert.ok(audit.events.some((x) => x.event === 'workflow.limits_changed'));
  });
});

test('a start over the daily limit is refused with a reason; removing the limit lets it start again', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    await e.server.request('PUT', ctl(e, wf, 'limits'), { compilationId: e.compilationId, dailyRunCap: 1 });
    const start = () => e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: flowIn });
    assert.equal((await start()).status, 201);
    const second = await start();
    assert.equal(second.status, 412);
    assert.equal(second.json<{ error: { context?: { reason?: string } } }>().error.context?.reason, 'daily_cap_reached');
    await e.server.request('PUT', ctl(e, wf, 'limits'), { compilationId: e.compilationId, dailyRunCap: null });
    assert.equal((await start()).status, 201);
    for (const bad of [0, 1.5, '3', 100_001])
      assert.equal(
        (await e.server.request('PUT', ctl(e, wf, 'limits'), { compilationId: e.compilationId, dailyRunCap: bad })).status,
        400,
        String(bad),
      );
  });
});

test('pause everything stops every kind of start, can be lifted, needs manage, and a workflow pause remembers its earlier mode', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    const viewer = await addMember(e, 'view2', 'viewer');
    const publisher = await addMember(e, 'pub2', 'publisher');
    const start = () => e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: flowIn });

    assert.equal(
      (await e.server.request('POST', ws(e, '/workflow-controls/pause'), { reason: 'x' }, TestServer.authHeader(viewer))).status,
      403,
    );
    assert.equal(
      (await e.server.request('POST', ws(e, '/workflow-controls/pause'), { reason: 'x' }, TestServer.authHeader(publisher))).status,
      403,
      'only manage may pause everything',
    );
    const paused = await e.server.request('POST', ws(e, '/workflow-controls/pause'), { reason: 'Investigating a bad batch' });
    assert.equal(paused.status, 200);
    assert.equal(paused.json<{ paused: boolean; reason: string }>().reason, 'Investigating a bad batch');
    const refused = await start();
    assert.equal(refused.status, 412);
    assert.equal(refused.json<{ error: { context?: { reason?: string } } }>().error.context?.reason, 'workspace_paused');
    assert.equal((await e.server.request('GET', ws(e, '/workflow-controls'))).json<{ paused: boolean }>().paused, true);
    await e.server.request('POST', ws(e, '/workflow-controls/resume'));
    assert.equal((await start()).status, 201);

    // Pausing one workflow remembers where it was, and resuming returns there.
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' });
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'paused' });
    const one = await start();
    assert.equal(one.json<{ error: { context?: { reason?: string } } }>().error.context?.reason, 'workflow_paused');
    const back = await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' });
    assert.equal(back.json<Dep>().mode, 'shadow');
    const audit = (await e.server.request('GET', ws(e, '/audit/events')))
      .json<{ events: { event: string }[] }>()
      .events.map((x) => x.event);
    assert.ok(audit.includes('workflows.paused') && audit.includes('workflows.resumed'));
  });
});

test('webhook: refused until switched on and the workflow is practising or live; then it starts a recorded, gated run; replays are not repeated', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    const hook = (headers?: Record<string, string>) =>
      e.server.request('POST', ws(e, `/workflows/${wf}/webhook`), { compilationId: e.compilationId, input: flowIn }, headers);
    const off = await hook();
    assert.equal(off.status, 412);
    assert.equal(off.json<{ error: { context?: { reason?: string } } }>().error.context?.reason, 'trigger_inactive');
    await e.server.request('PUT', ctl(e, wf, 'triggers'), { compilationId: e.compilationId, webhook: true });
    assert.equal((await hook()).status, 412, 'on, but the workflow is still a draft');
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' });
    const first = await hook({ 'idempotency-key': 'hook-replay-1' });
    assert.equal(first.status, 201, first.bodyText);
    assert.equal(first.json<{ trigger: string; shadow: { outcome: string } }>().trigger, 'webhook');
    const replay = await hook({ 'idempotency-key': 'hook-replay-1' });
    assert.equal(replay.status, 201, 'a replay mirrors the original status (it is marked by the idempotent-replayed header)');
    assert.equal(
      replay.json<{ workflowExecutionId: string }>().workflowExecutionId,
      first.json<{ workflowExecutionId: string }>().workflowExecutionId,
    );
    const runs = (await e.server.request('GET', ws(e, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>()
      .workflowExecutions;
    assert.equal(runs.length, 1, 'a replay never starts a second run');
    // A caller who is not an author cannot use it, and an unauthenticated one is refused outright.
    const viewer = await addMember(e, 'view3', 'viewer');
    assert.equal((await hook(TestServer.authHeader(viewer))).status, 403);
    assert.equal(
      (await e.server.request('POST', ws(e, `/workflows/${wf}/webhook`), { compilationId: e.compilationId }, undefined, { skipAuth: true }))
        .status,
      401,
    );
  });
});

test('practice review: a reviewer judges a practice run, agreement is counted, and only real practice runs can be judged', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    // A normal (non-practice) run exists first; it can never be judged.
    const normal = (
      await e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: flowIn })
    ).json<{ workflowExecutionId: string }>();
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' });
    const practice = (
      await e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: flowIn })
    ).json<{ workflowExecutionId: string }>();
    const judge = (id: string, judgement: unknown) =>
      e.server.request('POST', ctl(e, wf, 'shadow-reviews'), { compilationId: e.compilationId, workflowExecutionId: id, judgement });
    assert.equal((await judge(normal.workflowExecutionId, 'automatic')).status, 404);
    assert.equal((await judge('wfx_nope', 'automatic')).status, 404);
    assert.equal((await judge(practice.workflowExecutionId, 'maybe')).status, 400);
    const done = await judge(practice.workflowExecutionId, 'automatic');
    assert.equal(done.status, 200, done.bodyText);
    assert.deepEqual(done.json<Dep>().shadow, { runs: 1, wouldComplete: 1, wouldEscalate: 0, reviewed: 1, agreed: 1 });
    assert.equal(done.json<Dep>().shadowCases[0]?.judgement, 'automatic');
    const disagree = await judge(practice.workflowExecutionId, 'person');
    assert.deepEqual(
      { reviewed: disagree.json<Dep>().shadow.reviewed, agreed: disagree.json<Dep>().shadow.agreed },
      { reviewed: 1, agreed: 0 },
    );
  });
});

test('the schedule: fires only when due, only while practising or live, goes through the same gate, records what happened, and does not catch up', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    const store = new FsWorkspaceStore(new LocalFsBlobStore(e.workspacesDir));
    // The scheduler is a server-side trigger: it runs as the `trigger-schedule` service principal through the SAME enforcement as the API
    // (permission manager, audit service, package trust). The default policy denies only steps that declare permissions.
    const deps = {
      workspaceStore: store,
      dataConfig: { dataRootDir: e.dataDir, packageTrustPolicy: PackageTrustPolicy.development() },
      permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
      audit: new AuditService(new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS })),
    };
    const set = (every: number | null, input?: unknown) =>
      e.server.request('PUT', ctl(e, wf, 'triggers'), {
        compilationId: e.compilationId,
        schedule: every === null ? null : { everyMinutes: every, ...(input !== undefined ? { input } : {}) },
      });
    assert.equal((await set(4)).status, 400);
    assert.equal((await set(10_081)).status, 400);
    assert.equal((await set(10, [1])).status, 400, 'input must be an object');
    assert.equal((await set(10, { blob: 'x'.repeat(9000) })).status, 400, 'input is bounded');
    assert.equal((await set(10, flowIn)).status, 200);
    const t0 = new Date();
    // Draft: nothing fires, however much time passes.
    assert.deepEqual(await runDueSchedules(deps, new Date(t0.getTime() + 3_600_000)), { started: 0, skipped: 0 });
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' });
    // Practising but not yet a full interval since the schedule was switched on.
    assert.deepEqual(await runDueSchedules(deps, new Date(t0.getTime() + 5 * 60_000)), { started: 0, skipped: 0 });
    // Due: starts one run with the schedule's stored input.
    const due = new Date(t0.getTime() + 11 * 60_000);
    assert.deepEqual(await runDueSchedules(deps, due), { started: 1, skipped: 0 });
    const d = (await e.server.request('GET', ws(e, '/workflow-controls')))
      .json<{ deployments: (Dep & { workflowId: string })[] }>()
      .deployments.find((x) => x.workflowId === wf)!;
    assert.match(d.triggers.schedule!.lastOutcome ?? '', /started/);
    const runs = (await e.server.request('GET', ws(e, '/workflow-executions'))).json<{ workflowExecutions: { trigger?: string }[] }>()
      .workflowExecutions;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.trigger, 'schedule');
    // The very next tick is not due again; a long outage fires ONE run, not many.
    assert.deepEqual(await runDueSchedules(deps, new Date(due.getTime() + 60_000)), { started: 0, skipped: 0 });
    assert.deepEqual(await runDueSchedules(deps, new Date(due.getTime() + 3 * 24 * 3_600_000)), { started: 1, skipped: 0 });
    // The same gate applies: with everything paused the slot is skipped, recorded, and not queued.
    await e.server.request('POST', ws(e, '/workflow-controls/pause'), {});
    const skipped = await runDueSchedules(deps, new Date(due.getTime() + 6 * 24 * 3_600_000));
    assert.deepEqual(skipped, { started: 0, skipped: 1 });
    const after = (await e.server.request('GET', ws(e, '/workflow-controls')))
      .json<{ deployments: (Dep & { workflowId: string })[] }>()
      .deployments.find((x) => x.workflowId === wf)!;
    assert.match(after.triggers.schedule!.lastOutcome ?? '', /skipped: workspace_paused/);
    const audit = (await e.server.request('GET', ws(e, '/audit/events'))).json<{ events: { event: string }[] }>().events;
    assert.ok(audit.filter((x) => x.event === 'workflow.triggered').length >= 3);
  });
});

test('adversarial: unknown fields, wrong types, a workflow from another compilation, an oversized webhook input and a damaged controls file all fail closed', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    const post = (action: string, body: unknown, method: 'POST' | 'PUT' = 'POST') => e.server.request(method, ctl(e, wf, action), body);
    assert.equal((await post('mode', { compilationId: e.compilationId, mode: 'shadow', extra: 1 })).status, 400);
    assert.equal((await post('mode', { compilationId: e.compilationId, mode: 'turbo' })).status, 400);
    assert.equal((await post('mode', { mode: 'shadow' })).status, 400, 'compilationId is required');
    assert.equal((await post('mode', { compilationId: 'cmp_nope', mode: 'shadow' })).status, 404);
    assert.equal(
      (await e.server.request('POST', ctl(e, 'wf_nope', 'mode'), { compilationId: e.compilationId, mode: 'shadow' })).status,
      404,
    );
    assert.equal((await post('triggers', { compilationId: e.compilationId, webhook: 'yes' }, 'PUT')).status, 400);
    assert.equal(
      (await post('triggers', { compilationId: e.compilationId, schedule: { everyMinutes: 10, cron: '* * * * *' } }, 'PUT')).status,
      400,
    );
    assert.equal((await post('pause', {})).status, 404, 'there is no per-workflow pause path other than the mode');

    // Oversized webhook input is refused before anything starts.
    await e.server.request('PUT', ctl(e, wf, 'triggers'), { compilationId: e.compilationId, webhook: true });
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' });
    const huge = await e.server.request('POST', ws(e, `/workflows/${wf}/webhook`), {
      compilationId: e.compilationId,
      input: { blob: 'x'.repeat(70 * 1024) },
    });
    assert.equal(huge.status, 400);
    const arrayInput = await e.server.request('POST', ws(e, `/workflows/${wf}/webhook`), { compilationId: e.compilationId, input: [1, 2] });
    assert.equal(arrayInput.status, 400);

    // Another identity cannot see or change any of it.
    const stranger = (await e.server.issueAdditionalIdentity('stranger')).apiKey;
    assert.equal((await e.server.request('GET', ws(e, '/workflow-controls'), undefined, TestServer.authHeader(stranger))).status, 404);
    assert.equal((await e.server.request('POST', ws(e, '/workflow-controls/pause'), {}, TestServer.authHeader(stranger))).status, 404);

    // A damaged switch file must never read as "not paused": nothing starts.
    await e.server.request('POST', ws(e, '/workflow-controls/pause'), {});
    await e.server.request('POST', ws(e, '/workflow-controls/resume'));
    const found = await findFile(e.dataDir, 'workspace.json');
    assert.ok(found, 'the switch file exists');
    await writeFile(found, '{ not json');
    const start = await e.server.request('POST', ws(e, `/workflows/${wf}/executions`), { compilationId: e.compilationId, input: flowIn });
    assert.ok(start.status >= 500, `a damaged controls file must stop the start, got ${start.status}`);
    const after = (await e.server.request('GET', ws(e, '/workflows'))).json<{ workflows: unknown[] }>();
    assert.ok(after.workflows.length > 0, 'reading workflows still works; only starting is stopped');
    assert.equal(
      (await e.server.request('GET', ws(e, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>().workflowExecutions.length,
      0,
      'nothing was started',
    );
    await readFile(found); // still there, untouched by the server
  });
});

async function findFile(dir: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit !== undefined) return hit;
    } else if (entry.name === name && p.includes('workflow-controls')) return p;
  }
  return undefined;
}
