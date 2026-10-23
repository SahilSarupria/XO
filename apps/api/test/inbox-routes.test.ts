import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TestServer, withTempDir } from './test-helpers.js';

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const HITL = 'cap_ce5ac3d1b7e3d22d184b1d089f8c3522';
const as = (k: { apiKey: string }) => TestServer.authHeader(k.apiKey);

async function withPendingTask<T>(
  fn: (ctx: { server: TestServer; base: string; executionId: string; compilationId: string }) => Promise<T>,
): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const ws = (await server.request('POST', '/workspaces', { name: 'Inbox' })).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        const src = (await server.request('POST', `${base}/sources?filename=policy.pdf`, await readFile(PDF))).json<{ sourceId: string }>();
        const comp = (await server.request('POST', `${base}/sources/${src.sourceId}/compile`)).json<{
          compilationId: string;
          status: string;
        }>();
        assert.equal(comp.status, 'succeeded');
        await server.request('POST', `${base}/compilations/${comp.compilationId}/capabilities/${HITL}/approve`);
        const exec = (
          await server.request('POST', `${base}/executions`, { compilationId: comp.compilationId, capabilityId: HITL, input: {} })
        ).json<{ executionId: string; status: string }>();
        assert.equal(exec.status, 'waiting_for_human');
        return await fn({ server, base, executionId: exec.executionId, compilationId: comp.compilationId });
      } finally {
        await server.stop();
      }
    }),
  );
}

interface Item {
  executionId: string;
  state: string;
  title: string;
  sourceFilename?: string;
  confidence?: number;
  openInfoRequests: number;
  decision?: string;
}

test('inbox lists pending tasks with capability name, source file and confidence read from real records', async () => {
  await withPendingTask(async ({ server, base, executionId }) => {
    const res = (await server.request('GET', `${base}/inbox`)).json<{ items: Item[]; counts: { needsReview: number; done: number } }>();
    assert.deepEqual(res.counts, { needsReview: 1, done: 0 });
    const item = res.items[0]!;
    assert.equal(item.executionId, executionId);
    assert.equal(item.state, 'needs_review');
    assert.equal(item.sourceFilename, 'policy.pdf');
    assert.match(item.title, /Review/i);
    assert.equal(typeof item.confidence, 'number');
    assert.equal(item.openInfoRequests, 0);
    assert.equal((await server.request('GET', `${base}/inbox?state=done`)).json<{ items: unknown[] }>().items.length, 0);
    assert.equal((await server.request('GET', `${base}/inbox?state=bogus`)).status, 400);
  });
});

test('inbox detail carries input, the runtime escalation, capability evidence and trace', async () => {
  await withPendingTask(async ({ server, base, executionId }) => {
    const d = (await server.request('GET', `${base}/inbox/${executionId}`)).json<Record<string, any>>();
    assert.equal(d['executionId'], executionId);
    assert.deepEqual(d['input'], {});
    assert.equal(d['escalation'].status, 'escalation_required');
    assert.equal(d['capability'].id, HITL);
    assert.ok(Array.isArray(d['capability'].evidence));
    assert.ok(d['trace'].contractId !== undefined);
    assert.deepEqual(d['infoRequests'], []);
    assert.equal((await server.request('GET', `${base}/inbox/exec_does_not_exist`)).status, 404);
  });
});

test('ask for more info: reviewers ask, authors answer, the task stays pending, and nothing is overwritten', async () => {
  await withPendingTask(async ({ server, base, executionId }) => {
    const reviewer = await server.issueAdditionalIdentity('rev');
    const viewer = await server.issueAdditionalIdentity('view');
    const author = await server.issueAdditionalIdentity('auth');
    for (const [id, role] of [
      ['rev', 'reviewer'],
      ['view', 'viewer'],
      ['auth', 'publisher'],
    ] as const) {
      await server.request('POST', `${base}/members`, { identityId: id, role });
    }
    assert.equal(
      (await server.request('POST', `${base}/inbox/${executionId}/info-requests`, { question: 'Was there forced entry?' }, as(viewer)))
        .status,
      403,
    );
    assert.equal(
      (await server.request('POST', `${base}/inbox/${executionId}/info-requests`, { question: '   ' }, as(reviewer))).status,
      400,
    );

    const asked = await server.request(
      'POST',
      `${base}/inbox/${executionId}/info-requests`,
      { question: 'Was there forced entry?' },
      as(reviewer),
    );
    assert.equal(asked.status, 201);
    const requestId = asked.json<{ requestId: string; requestedBy: string }>();
    assert.equal(requestId.requestedBy, 'rev');

    let list = (await server.request('GET', `${base}/inbox`)).json<{ items: Item[] }>();
    assert.equal(list.items[0]?.openInfoRequests, 1);
    assert.equal(list.items[0]?.state, 'needs_review', 'asking for info never resolves the task');

    assert.equal(
      (
        await server.request(
          'POST',
          `${base}/inbox/${executionId}/info-requests/${requestId.requestId}/answer`,
          { answer: 'Photos attached' },
          as(reviewer),
        )
      ).status,
      403,
      'a reviewer has no author permission',
    );
    const answered = await server.request(
      'POST',
      `${base}/inbox/${executionId}/info-requests/${requestId.requestId}/answer`,
      { answer: 'Photos attached' },
      as(author),
    );
    assert.equal(answered.status, 200);
    assert.equal(answered.json<{ answeredBy: string }>().answeredBy, 'auth');
    assert.equal(
      (
        await server.request(
          'POST',
          `${base}/inbox/${executionId}/info-requests/${requestId.requestId}/answer`,
          { answer: 'changed' },
          as(author),
        )
      ).status,
      409,
    );
    assert.equal(
      (await server.request('POST', `${base}/inbox/${executionId}/info-requests/ir_nope/answer`, { answer: 'x' }, as(author))).status,
      404,
    );

    list = (await server.request('GET', `${base}/inbox`)).json<{ items: Item[] }>();
    assert.equal(list.items[0]?.openInfoRequests, 0);
    const detail = (await server.request('GET', `${base}/inbox/${executionId}`)).json<{ infoRequests: { answer?: string }[] }>();
    assert.equal(detail.infoRequests[0]?.answer, 'Photos attached');
    const audit = (await server.request('GET', `${base}/audit/events?event=human_task.info_requested`)).json<{ events: unknown[] }>();
    assert.equal(audit.events.length, 1);
  });
});

test('after resolution the task moves to Done with the decision and resolver, and no more info can be requested', async () => {
  await withPendingTask(async ({ server, base, executionId }) => {
    const reviewer = await server.issueAdditionalIdentity('rev2');
    await server.request('POST', `${base}/members`, { identityId: 'rev2', role: 'reviewer' });
    const res = await server.request('POST', `${base}/executions/${executionId}/resolve`, { decision: 'approve' }, as(reviewer));
    assert.equal(res.status, 200, res.bodyText);

    const list = (await server.request('GET', `${base}/inbox`)).json<{ items: Item[]; counts: { needsReview: number; done: number } }>();
    assert.deepEqual(list.counts, { needsReview: 0, done: 1 });
    assert.equal(list.items[0]?.state, 'done');
    assert.equal(list.items[0]?.decision, 'approve');
    assert.equal((list.items[0] as unknown as { resolverIdentityId: string }).resolverIdentityId, 'rev2');
    assert.equal((await server.request('POST', `${base}/inbox/${executionId}/info-requests`, { question: 'too late?' })).status, 412);
    const audit = (await server.request('GET', `${base}/audit/events?event=human_task.resolved`)).json<{
      events: { result: string; actor: { identityId: string } }[];
    }>();
    assert.equal(audit.events[0]?.result, 'approved');
    assert.equal(audit.events[0]?.actor.identityId, 'rev2');
  });
});
