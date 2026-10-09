import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/http/router.js';
import type { ApiRequest } from '../src/http/types.js';

function fakeRequest(overrides: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'GET',
    path: '/',
    params: {},
    query: new URLSearchParams(),
    headers: {},
    rawBody: async () => Buffer.alloc(0),
    json: async () => ({ ok: false, error: new Error('not used') }) as never,
    ...overrides,
  };
}

test('resolve() matches a literal path for the right method', async () => {
  const router = new Router();
  router.get('/health', async () => ({ status: 200, body: { status: 'ok' } }));

  const resolved = router.resolve('GET', '/health');
  assert.ok(resolved);
  const response = await resolved.handler(fakeRequest());
  assert.deepEqual(response, { status: 200, body: { status: 'ok' } });
});

test('resolve() returns undefined for an unregistered path', () => {
  const router = new Router();
  router.get('/health', async () => ({ status: 200 }));
  assert.equal(router.resolve('GET', '/nope'), undefined);
});

test('resolve() returns undefined for the right path but wrong method, and hasPathForOtherMethod() reports it', () => {
  const router = new Router();
  router.get('/packages/:id', async () => ({ status: 200 }));

  assert.equal(router.resolve('POST', '/packages/abc'), undefined);
  assert.equal(router.hasPathForOtherMethod('POST', '/packages/abc'), true);
  assert.equal(router.hasPathForOtherMethod('POST', '/nonexistent'), false);
});

test('resolve() extracts :param segments, URL-decoded', async () => {
  const router = new Router();
  router.get('/registry/packages/:id/benchmarks/:benchmarkId', async (req) => ({ status: 200, body: req.params }));

  const resolved = router.resolve('GET', '/registry/packages/sha256%3Aabc/benchmarks/run-1');
  assert.ok(resolved);
  const response = await resolved.handler(fakeRequest({ params: resolved.params }));
  assert.deepEqual(response.body, { id: 'sha256:abc', benchmarkId: 'run-1' });
});

test('resolve() does not match a route with a different segment count', () => {
  const router = new Router();
  router.get('/packages/:name/:version/manifest', async () => ({ status: 200 }));
  assert.equal(router.resolve('GET', '/packages/foo/manifest'), undefined);
  assert.equal(router.resolve('GET', '/packages/foo/1.0.0/manifest/extra'), undefined);
});

test('use() composes middleware outermost-first around the matched handler', async () => {
  const router = new Router();
  const calls: string[] = [];
  router.use(async (req, next) => {
    calls.push('mw1-before');
    const res = await next();
    calls.push('mw1-after');
    return res;
  });
  router.use(async (req, next) => {
    calls.push('mw2-before');
    const res = await next();
    calls.push('mw2-after');
    return res;
  });
  router.get('/x', async () => {
    calls.push('handler');
    return { status: 200 };
  });

  const resolved = router.resolve('GET', '/x');
  assert.ok(resolved);
  await resolved.handler(fakeRequest());
  assert.deepEqual(calls, ['mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after']);
});

test('a middleware can short-circuit and never call next()', async () => {
  const router = new Router();
  router.use(async () => ({ status: 401, body: { blocked: true } }));
  router.get('/x', async () => ({ status: 200, body: { reached: true } }));

  const resolved = router.resolve('GET', '/x');
  assert.ok(resolved);
  const response = await resolved.handler(fakeRequest());
  assert.deepEqual(response, { status: 401, body: { blocked: true } });
});
