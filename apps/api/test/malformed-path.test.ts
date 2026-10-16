import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, XoError } from '@xo/errors';
import { Router } from '../src/http/router.js';
import { json } from '../src/http/types.js';
import { TestServer } from './test-helpers.js';

// P1.0 closure (M7 observation, owner-directed narrow fix): a path parameter that is not valid percent-encoding used to make
// `decodeURIComponent` throw inside route resolution, which the server answered with an unauthenticated generic 500. It is a
// malformed client request: 400 `INVALID_ARGUMENT`, offending text never echoed, authentication behaviour unchanged.

const MALFORMED = ['%E0%A4%A', '%', '%zz', '%C0%80', 'abc%'];

test('router: a malformed percent-encoded param throws a 400-class XoError that does not echo the input; well-formed encoding still decodes', () => {
  const router = new Router();
  router.get('/things/:id/parts', async () => json(200, {}));
  for (const bad of MALFORMED) {
    assert.throws(
      () => router.resolve('GET', `/things/${bad}/parts`),
      (e: unknown) => e instanceof XoError && e.code === ErrorCode.INVALID_ARGUMENT && !e.message.includes(bad),
      bad,
    );
  }
  assert.equal(router.resolve('GET', '/things/a%20b/parts')?.params['id'], 'a b');
  assert.equal(router.resolve('GET', '/things/%E2%9C%93/parts')?.params['id'], '✓');
});

test('router: decoding happens only for a route whose shape matches — literal mismatches and other shapes never throw', () => {
  const router = new Router();
  router.get('/things/:id/parts', async () => json(200, {}));
  assert.equal(router.resolve('GET', '/things/%E0%A4%A/other'), undefined, 'literal mismatch: no decode, no throw');
  assert.equal(router.resolve('GET', '/things/%E0%A4%A'), undefined, 'segment count mismatch: no decode, no throw');
  assert.equal(router.resolve('POST', '/things/ok/parts'), undefined, 'wrong method: unchanged');
});

test('HTTP: malformed percent-encoding is a 400 INVALID_ARGUMENT — authenticated or not — never a 500, and nothing is echoed', async () => {
  const server = await TestServer.start();
  try {
    for (const bad of MALFORMED) {
      for (const path of [`/workspaces/${bad}/human-tasks`, `/workspaces/ws-1/executions/${bad}`]) {
        for (const skipAuth of [false, true]) {
          const res = await server.request('GET', path, undefined, {}, { skipAuth });
          assert.equal(res.status, 400, `${path} skipAuth=${skipAuth}: ${res.bodyText}`);
          assert.equal(res.json<{ error: { code: string } }>().error.code, ErrorCode.INVALID_ARGUMENT);
          assert.ok(!res.bodyText.includes(bad), 'the offending text is not echoed');
        }
      }
    }
    // a malformed param on a path whose route exists only for another method: still a client error, not a 500
    const wrongMethod = await server.request('POST', '/workspaces/%E0%A4%A/human-tasks');
    assert.equal(wrongMethod.status, 400);
  } finally {
    await server.stop();
  }
});

test('HTTP: authentication is not weakened — well-formed requests are still 401 without a key, 404 and wrong-method responses are unchanged, encoded ids still decode', async () => {
  const server = await TestServer.start();
  try {
    const noKey = await server.request('GET', '/workspaces/ws-1/human-tasks', undefined, {}, { skipAuth: true });
    assert.equal(noKey.status, 401);
    assert.equal(noKey.json<{ error: { code: string } }>().error.code, ErrorCode.AUTH_KEY_MISSING);

    assert.equal((await server.request('GET', '/definitely-not-a-route', undefined, {}, { skipAuth: true })).status, 404);
    // pre-existing behaviour, unchanged by this fix: a known path with the wrong method answers with the UNIMPLEMENTED code (501)
    const wrongMethod = await server.request('POST', '/health', undefined, {}, { skipAuth: true });
    assert.equal(wrongMethod.status, 501);
    assert.equal(wrongMethod.json<{ error: { code: string } }>().error.code, ErrorCode.UNIMPLEMENTED);

    // `%77s-1` decodes to `ws-1`: an authenticated, well-formed encoded id reaches the handler (uniform 404 for an unknown workspace).
    const encoded = await server.request('GET', '/workspaces/%77s-1/human-tasks');
    assert.equal(encoded.status, 404, encoded.bodyText);
  } finally {
    await server.stop();
  }
});
