import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { judge } from '../src/test-cases/test-case.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

interface CaseWire {
  caseId: string;
  revision: number;
  name: string;
  expected: { status: string; output?: Record<string, unknown> };
  lastRun?: RunWire;
}
interface RunWire {
  runId: string;
  caseId: string;
  caseRevision: number;
  executionId: string;
  pass: boolean;
  actual: { status: string; output?: Record<string, unknown>; errorCode?: string };
  mismatches: string[];
}
interface Env {
  server: TestServer;
  workspace: WorkspaceRecord;
  compilationId: string;
  base: (capabilityId: string) => string;
  approve: (capabilityId: string) => Promise<void>;
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-tc-data-', async (dataDir) =>
    withTempDir('xo-tc-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const { compilationId } = await storeFixtureCompilation(workspace, dataDir);
        const prefix = `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities`;
        await fn({
          server,
          workspace,
          compilationId,
          base: (capabilityId) => `${prefix}/${capabilityId}`,
          approve: async (capabilityId) => {
            const res = await server.request('POST', `${prefix}/${capabilityId}/approve`);
            assert.ok(res.status === 200 || res.status === 201, res.bodyText);
          },
        });
      } finally {
        await server.stop();
      }
    }),
  );
}

const good = { name: 'large claim', input: { claim_amount: 15000 }, expected: { status: 'succeeded' } };

async function save(env: Env, cap: string, body: unknown = good): Promise<CaseWire> {
  const res = await env.server.request('POST', `${env.base(cap)}/test-cases`, body);
  assert.equal(res.status, 201, res.bodyText);
  return res.json<CaseWire>();
}

test('CRUD: strict body, revision-guarded update, delete removes the case and its history', async () => {
  await withEnv(async (env) => {
    const url = `${env.base(IDS.flowA)}/test-cases`;
    const c = await save(env, IDS.flowA);
    assert.equal(c.revision, 1);
    assert.equal((await env.server.request('GET', url)).json<{ testCases: CaseWire[] }>().testCases.length, 1);

    for (const bad of [
      { ...good, surprise: 1 },
      { ...good, name: '' },
      { ...good, expected: { status: 'maybe' } },
      { ...good, expected: { status: 'succeeded', verdict: 'pass' } },
      { ...good, input: [1] },
      { name: 'x' },
    ])
      assert.equal((await env.server.request('POST', url, bad)).status, 400, JSON.stringify(bad));

    const v2 = await env.server.request('PUT', `${url}/${c.caseId}`, { ...good, name: 'renamed', expectedRevision: 1 });
    assert.equal(v2.status, 200, v2.bodyText);
    assert.equal(v2.json<CaseWire>().revision, 2);
    const stale = await env.server.request('PUT', `${url}/${c.caseId}`, { ...good, name: 'stale', expectedRevision: 1 });
    assert.equal(stale.status, 412);
    assert.equal((await env.server.request('GET', `${url}/${c.caseId}`)).json<CaseWire>().name, 'renamed');

    assert.equal((await env.server.request('GET', `${env.base('cap_nope')}/test-cases`)).status, 404);
    assert.equal((await env.server.request('GET', `${url}/tc_${'0'.repeat(32)}`)).status, 404);

    await env.approve(IDS.flowA);
    await env.server.request('POST', `${url}/${c.caseId}/runs`);
    assert.equal((await env.server.request('GET', `${url}/${c.caseId}/runs`)).json<{ runs: unknown[] }>().runs.length, 1);
    assert.equal((await env.server.request('DELETE', `${url}/${c.caseId}`)).status, 200);
    assert.equal((await env.server.request('GET', `${url}/${c.caseId}`)).status, 404);
    assert.equal((await env.server.request('GET', url)).json<{ testCases: unknown[] }>().testCases.length, 0);
  });
});

test('running goes through the approval gate, then records a real execution and a platform-decided verdict', async () => {
  await withEnv(async (env) => {
    const url = `${env.base(IDS.flowA)}/test-cases`;
    const c = await save(env, IDS.flowA);
    const denied = await env.server.request('POST', `${url}/${c.caseId}/runs`);
    assert.equal(denied.status, 403, denied.bodyText);
    assert.equal((await env.server.request('GET', `${url}/${c.caseId}/runs`)).json<{ runs: unknown[] }>().runs.length, 0);
    assert.equal(
      (await env.server.request('GET', `/workspaces/${env.workspace.workspaceId}/executions`)).json<{ executions: unknown[] }>().executions
        .length,
      0,
    );

    await env.approve(IDS.flowA);
    const ran = await env.server.request('POST', `${url}/${c.caseId}/runs`);
    assert.equal(ran.status, 200, ran.bodyText);
    const run = ran.json<RunWire>();
    assert.equal(run.pass, true, JSON.stringify(run));
    assert.equal(run.actual.status, 'succeeded');
    assert.equal(run.caseRevision, 1);
    const exec = await env.server.request('GET', `/workspaces/${env.workspace.workspaceId}/executions/${run.executionId}`);
    assert.equal(exec.status, 200);

    // An output subset taken from what really happened passes; a wrong one fails with the reason.
    const matched = run.actual.output?.['matched'];
    assert.notEqual(matched, undefined, 'fixture output has "matched"');
    const right = await save(env, IDS.flowA, { ...good, name: 'subset ok', expected: { status: 'succeeded', output: { matched } } });
    const wrong = await save(env, IDS.flowA, {
      ...good,
      name: 'subset wrong',
      expected: { status: 'succeeded', output: { matched: !matched } },
    });
    const wrongStatus = await save(env, IDS.flowA, { ...good, name: 'wrong status', expected: { status: 'failed' } });
    const all = (await env.server.request('POST', `${env.base(IDS.flowA)}/test-case-runs`)).json<{
      runs: RunWire[];
      passed: number;
      failed: number;
    }>();
    assert.equal(all.runs.length, 4);
    const byCase = (id: string) => all.runs.find((r) => r.caseId === id)!;
    assert.equal(byCase(right.caseId).pass, true);
    assert.equal(byCase(wrong.caseId).pass, false);
    assert.match(byCase(wrong.caseId).mismatches.join('|'), /output\.matched/);
    assert.equal(byCase(wrongStatus.caseId).pass, false);
    assert.match(byCase(wrongStatus.caseId).mismatches.join('|'), /status: expected "failed", got "succeeded"/);
    assert.deepEqual([all.passed, all.failed], [2, 2]);

    // Named subset, history newest first, lastRun on the list.
    const one = (await env.server.request('POST', `${env.base(IDS.flowA)}/test-case-runs`, { caseIds: [c.caseId] })).json<{
      runs: RunWire[];
    }>();
    assert.equal(one.runs.length, 1);
    const hist = (await env.server.request('GET', `${url}/${c.caseId}/runs`)).json<{ runs: RunWire[] }>().runs;
    assert.equal(hist.length, 3);
    assert.equal(hist[0]!.runId, one.runs[0]!.runId);
    const listed = (await env.server.request('GET', url)).json<{ testCases: CaseWire[] }>().testCases.find((x) => x.caseId === c.caseId)!;
    assert.equal(listed.lastRun?.runId, hist[0]!.runId);
    assert.equal(
      (await env.server.request('POST', `${env.base(IDS.flowA)}/test-case-runs`, { caseIds: ['tc_' + '0'.repeat(32)] })).status,
      404,
    );
    assert.equal((await env.server.request('POST', `${env.base(IDS.flowA)}/test-case-runs`, { cases: [] })).status, 400);

    const audit = (await env.server.request('GET', `/workspaces/${env.workspace.workspaceId}/audit/events?event=execution.test_run`)).json<{
      events: { detail?: Record<string, unknown> }[];
    }>().events;
    assert.ok(audit.length >= 4 && audit.every((e) => typeof e.detail?.['caseId'] === 'string' && typeof e.detail?.['pass'] === 'boolean'));
  });
});

test('invalid input is a real failed execution, and a case that expects failure passes on it', async () => {
  await withEnv(async (env) => {
    await env.approve(IDS.flowA);
    const c = await save(env, IDS.flowA, { name: 'bad input', input: { claim_amount: 'lots' }, expected: { status: 'failed' } });
    const run = (await env.server.request('POST', `${env.base(IDS.flowA)}/test-cases/${c.caseId}/runs`)).json<RunWire>();
    assert.equal(run.actual.status, 'failed');
    assert.equal(run.pass, true);
  });
});

test('a case expecting waiting_for_human really opens a human task through the existing path', async () => {
  await withEnv(async (env) => {
    await env.approve(IDS.hitlB);
    const c = await save(env, IDS.hitlB, {
      name: 'needs a person',
      input: { screening_score: 90, settlement_amount: 800 },
      expected: { status: 'waiting_for_human' },
    });
    const res = await env.server.request('POST', `${env.base(IDS.hitlB)}/test-cases/${c.caseId}/runs`);
    assert.equal(res.status, 200, res.bodyText);
    const run = res.json<RunWire>();
    assert.equal(run.actual.status, 'waiting_for_human', JSON.stringify(run));
    assert.equal(run.pass, true);
    const exec = (await env.server.request('GET', `/workspaces/${env.workspace.workspaceId}/executions/${run.executionId}`)).json<{
      humanTask?: { status: string };
    }>();
    assert.equal(exec.humanTask?.status, 'pending');
  });
});

test("roles: viewers read only, reviewers may run but not edit, authors do both; refusals are the platform's 403", async () => {
  await withEnv(async (env) => {
    const url = `${env.base(IDS.flowA)}/test-cases`;
    const c = await save(env, IDS.flowA);
    await env.approve(IDS.flowA);
    const viewer = await env.server.issueAdditionalIdentity('viewer-1');
    const reviewer = await env.server.issueAdditionalIdentity('reviewer-1');
    const publisher = await env.server.issueAdditionalIdentity('publisher-1');
    for (const [id, role] of [
      ['viewer-1', 'viewer'],
      ['reviewer-1', 'reviewer'],
      ['publisher-1', 'publisher'],
    ] as const)
      assert.equal(
        (await env.server.request('POST', `/workspaces/${env.workspace.workspaceId}/members`, { identityId: id, role })).status,
        201,
      );
    const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);

    assert.equal((await env.server.request('GET', url, undefined, as(viewer))).status, 200);
    assert.equal((await env.server.request('POST', url, good, as(viewer))).status, 403);
    assert.equal((await env.server.request('PUT', `${url}/${c.caseId}`, good, as(viewer))).status, 403);
    assert.equal((await env.server.request('DELETE', `${url}/${c.caseId}`, undefined, as(viewer))).status, 403);
    assert.equal((await env.server.request('POST', `${url}/${c.caseId}/runs`, undefined, as(viewer))).status, 403);

    assert.equal((await env.server.request('POST', url, good, as(reviewer))).status, 403);
    const byReviewer = await env.server.request('POST', `${url}/${c.caseId}/runs`, undefined, as(reviewer));
    assert.equal(byReviewer.status, 200, byReviewer.bodyText);

    const byPublisher = await env.server.request('POST', `${url}/${c.caseId}/runs`, undefined, as(publisher));
    assert.equal(byPublisher.status, 200, byPublisher.bodyText);
    assert.equal((await env.server.request('POST', url, good, as(publisher))).status, 201);
  });
});

test('air-gapped mode changes nothing here: cases are stored and run locally, with no outbound call to refuse', async () => {
  await withEnv(async (env) => {
    const set = await env.server.request('PUT', `/workspaces/${env.workspace.workspaceId}/settings`, { airGapped: true });
    assert.equal(set.status, 200, set.bodyText);
    await env.approve(IDS.flowA);
    const c = await save(env, IDS.flowA);
    const run = await env.server.request('POST', `${env.base(IDS.flowA)}/test-cases/${c.caseId}/runs`);
    assert.equal(run.status, 200, run.bodyText);
    assert.equal(run.json<RunWire>().pass, true);
  });
});

test('judge: status must match; output is a recursive subset; extra actual keys are fine', () => {
  const actual = { status: 'succeeded', output: { matched: true, detail: { band: 'high', n: 3 }, extra: 1 } };
  assert.equal(judge({ status: 'succeeded', output: { matched: true, detail: { band: 'high' } } }, actual).pass, true);
  assert.equal(judge({ status: 'succeeded', output: { detail: { band: 'low' } } }, actual).pass, false);
  assert.equal(judge({ status: 'succeeded', output: { missing: 1 } }, actual).pass, false);
  assert.equal(judge({ status: 'failed' }, actual).pass, false);
  assert.equal(judge({ status: 'succeeded', output: { a: 1 } }, { status: 'succeeded' }).pass, false);
});
