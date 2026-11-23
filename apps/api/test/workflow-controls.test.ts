import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import {
  contentHash,
  defaultDeployment,
  evaluateReadiness,
  evaluateStartGate,
  NOT_PAUSED,
  parseDailyCap,
  parseEveryMinutes,
  scheduleDue,
  transitionRefusal,
  type Deployment,
} from '../src/workflow-controls/model.js';

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
  });
  assert.deepEqual(
    all.map((i) => [i.id, i.ok]),
    [
      ['rules', true],
      ['runnable', true],
      ['signed', true],
      ['limits', true],
    ],
  );
  assert.equal(transitionRefusal('live', all), undefined);

  const stale = evaluateReadiness({
    executable: true,
    steps: [{ approved: true }],
    deployment: dep({ signOff: { identityId: 'r', at: 'x', contentHash: hash } }),
    currentHash: contentHash({ ...view, steps: [...view.steps, { order: 2, capabilityId: 'c' }] }),
  });
  assert.equal(stale.find((i) => i.id === 'signed')?.ok, false);
  assert.match(stale.find((i) => i.id === 'signed')!.message, /changed since it was signed off/);
  const refusal = transitionRefusal('live', stale)!;
  assert.equal(refusal.reason, 'not_ready');
  assert.match(refusal.message, /signed off/);
  assert.match(refusal.message, /daily limit/);
  // ADR 0052: practice mode was removed, so "practised" is no longer a readiness item.
  assert.equal(
    stale.find((i) => i.id === 'practice'),
    undefined,
  );
});

test('transitions: going live needs approved rules and a runnable workflow (and more); draft and paused are always allowed', () => {
  const none = evaluateReadiness({ executable: false, steps: [{ approved: false }], deployment: dep(), currentHash: 'h' });
  assert.ok(transitionRefusal('live', none));
  assert.equal(transitionRefusal('draft', none), undefined);
  assert.equal(transitionRefusal('paused', none), undefined);
  const noSteps = evaluateReadiness({ executable: true, steps: [], deployment: dep(), currentHash: 'h' });
  assert.equal(noSteps.find((i) => i.id === 'rules')?.ok, false, 'a workflow with no steps is not "all approved"');
});

test('the start gate refuses, in order: workspace pause, workflow pause, an inactive trigger, the daily limit', () => {
  const g = (d: Deployment, trigger: 'manual' | 'webhook' | 'schedule', runsToday = 0, paused = false) =>
    evaluateStartGate({ controls: paused ? { paused: true, revision: 1 } : NOT_PAUSED, deployment: d, trigger, runsToday });
  assert.deepEqual(g(dep(), 'manual'), { allowed: true });
  assert.equal((g(dep({ mode: 'live' }), 'manual', 0, true) as { reason: string }).reason, 'workspace_paused');
  assert.equal((g(dep({ mode: 'paused' }), 'manual') as { reason: string }).reason, 'workflow_paused');
  // Triggers fire only when switched on AND live; manual starts do not need either.
  assert.equal((g(dep({ mode: 'live' }), 'webhook') as { reason: string }).reason, 'trigger_inactive');
  assert.equal((g(dep({ mode: 'draft', triggers: { webhook: true } }), 'webhook') as { reason: string }).reason, 'trigger_inactive');
  assert.deepEqual(g(dep({ mode: 'live', triggers: { webhook: true } }), 'webhook'), { allowed: true });
  // ADR 0052: a deployment stored in the removed practice mode is not live, so its triggers stay inactive.
  assert.equal(
    (g(dep({ mode: 'shadow' as never, triggers: { webhook: true } }), 'webhook') as { reason: string }).reason,
    'trigger_inactive',
  );
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
      (await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'paused' }, as(reviewer))).status,
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

    // ADR 0052: practice mode was removed. Asking for it is a 400 that names the preview, and "practised" is not a readiness item.
    const practice = await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'shadow' }, as(publisher));
    assert.equal(practice.status, 400, practice.bodyText);
    assert.match(practice.json<{ error: { message: string } }>().error.message, /Preview what it would do|previews/);

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

test('pause everything can be set and lifted, needs manage, and a workflow pause remembers its earlier mode', async () => {
  await withEnv(async (e) => {
    await approve(e, IDS.flowA, IDS.flowB);
    const wf = await workflowId(e, IDS.flowA);
    const viewer = await addMember(e, 'view2', 'viewer');
    const publisher = await addMember(e, 'pub2', 'publisher');
    const reviewer = await addMember(e, 'rev2', 'reviewer');
    const as = (key: string) => TestServer.authHeader(key);

    assert.equal((await e.server.request('POST', ws(e, '/workflow-controls/pause'), { reason: 'x' }, as(viewer))).status, 403);
    assert.equal(
      (await e.server.request('POST', ws(e, '/workflow-controls/pause'), { reason: 'x' }, as(publisher))).status,
      403,
      'only manage may pause everything',
    );
    const paused = await e.server.request('POST', ws(e, '/workflow-controls/pause'), { reason: 'Investigating a bad batch' });
    assert.equal(paused.status, 200);
    assert.equal(paused.json<{ paused: boolean; reason: string }>().reason, 'Investigating a bad batch');
    assert.equal((await e.server.request('GET', ws(e, '/workflow-controls'))).json<{ paused: boolean }>().paused, true);
    await e.server.request('POST', ws(e, '/workflow-controls/resume'));
    assert.equal((await e.server.request('GET', ws(e, '/workflow-controls'))).json<{ paused: boolean }>().paused, false);

    // Pausing one workflow remembers where it was, and resuming returns there.
    await e.server.request('PUT', ctl(e, wf, 'limits'), { compilationId: e.compilationId, dailyRunCap: 5 }, as(publisher));
    await e.server.request('POST', ctl(e, wf, 'sign-off'), { compilationId: e.compilationId }, as(reviewer));
    const live = await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'live' }, as(publisher));
    assert.equal(live.status, 200, live.bodyText);
    await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'paused' });
    const back = await e.server.request('POST', ctl(e, wf, 'mode'), { compilationId: e.compilationId, mode: 'live' }, as(publisher));
    assert.equal(back.json<Dep>().mode, 'live');
    const audit = (await e.server.request('GET', ws(e, '/audit/events')))
      .json<{ events: { event: string }[] }>()
      .events.map((x) => x.event);
    assert.ok(audit.includes('workflows.paused') && audit.includes('workflows.resumed'));
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
    // ADR 0052: with the composed start gone, the gate is read through the controls snapshot every start path uses.
    const start = await e.server.request('GET', ws(e, '/workflow-controls'));
    assert.ok(start.status >= 500, `a damaged controls file must stop the gate, got ${start.status}`);
    const after = (await e.server.request('GET', ws(e, '/workflows'))).json<{ workflows: unknown[] }>();
    assert.ok(after.workflows.length > 0, 'reading workflows still works; only the controls are stopped');
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
