/**
 * S1-3 — `GET /version` (no credential; version and feature booleans only) and `POST /client-errors` (a signed-in person; the
 * server strips content from the message and route, refuses unknown fields, rate-limits, and logs, never audits).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';
import { messageTemplate, parseClientError, routePattern } from '../src/routes/platform-routes.js';

test('version: answered without a credential, with the API version and feature booleans only', async () => {
  await withTempDir('xo-api-version-', async (dir) => {
    const server = await TestServer.start({ workspaceDataDir: dir }, 'version-owner');
    try {
      const r = await fetch(`${server.baseUrl}/version`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as { version: string; features: Record<string, unknown> };
      assert.match(body.version, /^\d+\.\d+\.\d+/);
      assert.deepEqual(Object.keys(body.features).sort(), ['connect', 'googleSignIn', 'oidc', 'passwordSignIn']);
      for (const v of Object.values(body.features)) assert.equal(typeof v, 'boolean');
    } finally {
      await server.stop();
    }
  });
});

test('client errors: a signed-in report is accepted; unknown fields and an anonymous caller are refused; the rate limit holds', async () => {
  await withTempDir('xo-api-clienterr-', async (dir) => {
    const server = await TestServer.start({ workspaceDataDir: dir }, 'client-err-owner');
    try {
      const ok = await server.request('POST', '/client-errors', {
        kind: 'render',
        message: 'x is undefined',
        component: 'ActivitySection',
        route: '/w/:id/activity',
        build: '0.1.0',
        count: 1,
      });
      assert.equal(ok.status, 202, ok.bodyText);
      assert.equal((await server.request('POST', '/client-errors', { kind: 'render', message: 'x', extra: 1 })).status, 400);
      assert.equal((await server.request('POST', '/client-errors', { kind: 'oops', message: 'x' })).status, 400);
      const anon = await fetch(`${server.baseUrl}/client-errors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(anon.status, 401);
      let limited = 0;
      for (let i = 0; i < 25; i++)
        if ((await server.request('POST', '/client-errors', { kind: 'uncaught', message: 'y' })).status === 429) limited += 1;
      assert.ok(limited >= 5, 'after 20 a minute, reports are refused');
    } finally {
      await server.stop();
    }
  });
});

test('client errors carry no content: quoted text, numbers, addresses, ids and links become placeholders; routes keep their shape', () => {
  assert.equal(
    messageTemplate(
      `Cannot read 'Asha Rao' of undefined at row 12 for asha@client.example in run_aa90e208c191e4691a4a921b56004b44 (https://x.example/a?b=1)`,
    ),
    'Cannot read <text> of undefined at row <n> for <address> in <id> (<url>',
  );
  assert.ok(messageTemplate('a'.repeat(1000)).length <= 160);
  assert.equal(routePattern('/w/ws_1f2e3d/work/wfl_abc123/runs'), '/w/:id/work/:id/runs');
  assert.throws(() => parseClientError({ kind: 'render', message: 'x', component: 'Bad Name!' }), /component/);
  assert.throws(() => parseClientError({ kind: 'render', message: 'x', count: 0 }), /count/);
});
