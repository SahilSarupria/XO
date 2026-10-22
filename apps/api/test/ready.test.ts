import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-helpers.js';
import { resolveProvider } from '../src/routes/runtime/provider-factory.js';
import type { ApiRequest } from '../src/http/types.js';

test('/ready requires auth (only /health and /openapi.json are exempt)', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('GET', '/ready', undefined, {}, { skipAuth: true });
    assert.equal(res.status, 401);
  } finally {
    await server.stop();
  }
});

test('/ready reports inference configuration without calling the provider or exposing a credential', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('GET', '/ready');
    assert.equal(res.status, 200);
    const body = res.json<{ status: string; inference: { providerReachable: string; inferenceVerified: boolean; state: string } }>();
    assert.equal(body.status, 'ok');
    assert.equal(body.inference.providerReachable, 'not_checked');
    assert.equal(body.inference.inferenceVerified, false);
    assert.ok(['unconfigured', 'configured', 'invalid'].includes(body.inference.state));
    assert.ok(!JSON.stringify(body).toLowerCase().includes('aiza'));
  } finally {
    await server.stop();
  }
});

test('gemini ignores a caller-supplied x-xo-base-url (no redirecting the server credential)', async () => {
  const urls: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const req = { headers: { 'x-xo-provider': 'gemini', 'x-xo-base-url': 'https://evil.example.com' } } as unknown as ApiRequest;
    const result = resolveProvider(req, { GEMINI_API_KEY: 'k-123456' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    await result.value.complete({ model: 'gemini-3.5-flash-lite', maxOutputTokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(urls.length, 1);
    assert.ok(urls[0]!.startsWith('https://generativelanguage.googleapis.com/'), urls[0]);
  } finally {
    globalThis.fetch = orig;
  }
});
