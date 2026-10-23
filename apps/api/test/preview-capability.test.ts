import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ErrorCode } from '@xo/errors';
import { TestServer, withTempDir } from './test-helpers.js';

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const DETERMINISTIC = 'cap_4d97baf947ce09949680b2165c99f71d';
const HITL = 'cap_ce5ac3d1b7e3d22d184b1d089f8c3522';
const UNRESOLVED = 'cap_0c9cb78c4f61ea1ac0064e7040b94e9a';

interface Preview {
  previewOnly: boolean;
  approved: boolean;
  testRunAllowed: boolean;
  blockers: string[];
  preview: {
    kind: string;
    status?: string;
    externalEffects?: string;
    inputIssues?: { path: string; message: string }[];
    binding?: { implementationClass: string };
    plan?: string[];
  } | null;
}

async function withCompiled<T>(fn: (c: { server: TestServer; base: string; compilationId: string }) => Promise<T>): Promise<T> {
  return withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        const src = (await server.request('POST', `${base}/sources?filename=policy.pdf`, await readFile(PDF))).json<{ sourceId: string }>();
        const comp = (await server.request('POST', `${base}/sources/${src.sourceId}/compile`)).json<{
          compilationId: string;
          status: string;
        }>();
        assert.equal(comp.status, 'succeeded');
        return await fn({ server, base, compilationId: comp.compilationId });
      } finally {
        await server.stop();
      }
    }),
  );
}

const previewUrl = (base: string, compilationId: string, capabilityId: string) =>
  `${base}/compilations/${compilationId}/capabilities/${capabilityId}/preview`;
const executions = async (server: TestServer, base: string) =>
  (await server.request('GET', `${base}/executions`)).json<{ executions: unknown[] }>().executions;

test('preview works on an UNAPPROVED capability, says a real run is blocked, and changes nothing', async () => {
  await withCompiled(async ({ server, base, compilationId }) => {
    const res = await server.request('POST', previewUrl(base, compilationId, DETERMINISTIC), { input: {} });
    assert.equal(res.status, 200, res.bodyText);
    const p = res.json<Preview>();
    assert.equal(p.previewOnly, true);
    assert.equal(p.approved, false);
    assert.equal(p.testRunAllowed, false);
    assert.ok(p.blockers.some((b) => /not approved/.test(b)));
    assert.equal(p.preview?.kind, 'ready');
    assert.equal(p.preview?.binding?.implementationClass, 'deterministic_rule');
    assert.equal(p.preview?.externalEffects, 'none');
    assert.ok((p.preview?.plan ?? []).length >= 3);

    assert.deepEqual(await executions(server, base), [], 'a preview writes no execution record');
    const audit = (await server.request('GET', `${base}/audit/events?event=execution.created`)).json<{ events: unknown[] }>();
    assert.equal(audit.events.length, 0, 'and no execution audit entry');
  });
});

test('the approval gate is untouched: previewing never approves, and a real run is still refused until a reviewer approves', async () => {
  await withCompiled(async ({ server, base, compilationId }) => {
    for (let i = 0; i < 3; i++) await server.request('POST', previewUrl(base, compilationId, DETERMINISTIC), { input: {} });
    const run = await server.request('POST', `${base}/executions`, { compilationId, capabilityId: DETERMINISTIC, input: {} });
    assert.equal(run.status, 403, 'no amount of previewing makes an unapproved capability runnable');
    assert.deepEqual(await executions(server, base), []);
    const again = (await server.request('POST', previewUrl(base, compilationId, DETERMINISTIC), { input: {} })).json<Preview>();
    assert.equal(again.approved, false);
  });
});

test('a viewer cannot approve, and a publisher (author) cannot approve either; only review permission unlocks Test Run', async () => {
  await withCompiled(async ({ server, base, compilationId }) => {
    const author = await server.issueAdditionalIdentity('author-1');
    await server.request('POST', `${base}/members`, { identityId: 'author-1', role: 'publisher' });
    const asAuthor = TestServer.authHeader(author.apiKey);
    assert.equal(
      (await server.request('POST', `${base}/compilations/${compilationId}/capabilities/${DETERMINISTIC}/approve`, {}, asAuthor)).status,
      403,
    );
    assert.equal(
      (await server.request('POST', previewUrl(base, compilationId, DETERMINISTIC), { input: {} }, asAuthor)).status,
      200,
      'authors can preview',
    );
    assert.equal(
      (await server.request('POST', `${base}/executions`, { compilationId, capabilityId: DETERMINISTIC, input: {} }, asAuthor)).status,
      403,
      'and the gate still holds for them',
    );
  });
});

test('preview and the real run agree: input the preview rejects is rejected by the real run too, once approved', async () => {
  await withCompiled(async ({ server, base, compilationId }) => {
    await server.request('POST', `${base}/compilations/${compilationId}/capabilities/${DETERMINISTIC}/approve`);
    const bad = (await server.request('POST', previewUrl(base, compilationId, DETERMINISTIC), { input: 'nope' })).json<Preview>();
    assert.equal(bad.approved, true);
    assert.equal(bad.testRunAllowed, false);
    assert.ok(bad.preview?.inputIssues?.some((i) => i.path === '$' && /expected an object/.test(i.message)));
    assert.ok(bad.blockers.some((b) => /input schema/.test(b)));
    assert.ok(!bad.blockers.some((b) => /not approved/.test(b)));
    // The real run reports the same problem — as a persisted FAILED execution (the route's documented behavior: 200 + a failed record), which a preview never creates.
    const realBad = await server.request('POST', `${base}/executions`, { compilationId, capabilityId: DETERMINISTIC, input: 'nope' });
    assert.equal(realBad.status, 200);
    assert.equal(realBad.json<{ status: string; errorCode: string }>().status, 'failed');
    assert.equal(realBad.json<{ errorCode: string }>().errorCode, ErrorCode.RUNTIME_CAPABILITY_INPUT_INVALID);
    assert.equal((await executions(server, base)).length, 1, 'only the real run left a record; the previews before it left none');

    const good = (await server.request('POST', previewUrl(base, compilationId, DETERMINISTIC), { input: {} })).json<Preview>();
    const real = (await server.request('POST', `${base}/executions`, { compilationId, capabilityId: DETERMINISTIC, input: {} })).json<{
      status: string;
    }>();
    if (good.testRunAllowed)
      assert.notEqual(real.status, 'failed', 'preview allowed it, so the real run must not fail on input or binding');
    else assert.equal(real.status, 'failed', `preview blocked it (${good.blockers.join('; ')}), so the real run must fail`);
  });
});

test('a human-in-the-loop capability previews as "creates a human task" without creating one', async () => {
  await withCompiled(async ({ server, base, compilationId }) => {
    const p = (await server.request('POST', previewUrl(base, compilationId, HITL), { input: {} })).json<Preview>();
    assert.equal(p.preview?.kind, 'ready');
    assert.equal(p.preview?.binding?.implementationClass, 'human_in_the_loop');
    assert.equal(p.preview?.externalEffects, 'creates_human_task');
    assert.ok((p.preview?.plan ?? []).some((s) => /human task/.test(s)));
    const inbox = (await server.request('GET', `${base}/inbox`)).json<{ counts: { needsReview: number; done: number } }>();
    assert.deepEqual(inbox.counts, { needsReview: 0, done: 0 });
  });
});

test('a capability the runtime cannot bind is reported as unresolved with the reason, and a run is blocked', async () => {
  await withCompiled(async ({ server, base, compilationId }) => {
    const p = (await server.request('POST', previewUrl(base, compilationId, UNRESOLVED), { input: {} })).json<Preview>();
    assert.equal(p.preview?.kind, 'unresolved');
    assert.equal(p.testRunAllowed, false);
    assert.ok(p.blockers.some((b) => /could not be resolved/.test(b)));
  });
});

test('unknown capability or compilation is a 404, and the response always says it is only a preview', async () => {
  await withCompiled(async ({ server, base, compilationId }) => {
    assert.equal((await server.request('POST', previewUrl(base, compilationId, 'cap_doesnotexist'), {})).status, 404);
    assert.equal((await server.request('POST', previewUrl(base, 'cmp_doesnotexist', DETERMINISTIC), {})).status, 404);
    const ok = (await server.request('POST', previewUrl(base, compilationId, DETERMINISTIC), {})).json<{
      previewOnly: boolean;
      note: string;
    }>();
    assert.equal(ok.previewOnly, true);
    assert.match(ok.note, /does not prove the real run will succeed/);
  });
});
