import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer } from './test-helpers.js';

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
