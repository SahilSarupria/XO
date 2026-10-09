import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJson, XoirGraph, XoirGraphId } from '@xo/xoir';
import { TestServer } from './test-helpers.js';

/**
 * HTTP-level coverage of the thin route wrapper only — request/response
 * shape, status codes. `compile-adapter.test.ts` covers the adapter's
 * own logic (parsing, scoping decisions) directly.
 */

test('POST /compiler/compile with a valid empty xoir graph returns 200', async () => {
  const server = await TestServer.start();
  try {
    const graph = XoirGraph.create(XoirGraphId('http-test-graph'));
    const res = await server.request('POST', '/compiler/compile', { kind: 'xoir', graph: toJson(graph) });
    assert.equal(res.status, 200);
    const body = res.json<{ valid: boolean; graph: { id: string } }>();
    assert.equal(body.valid, true);
    assert.equal(body.graph.id, 'http-test-graph');
  } finally {
    await server.stop();
  }
});

test('POST /compiler/compile returns 501 for kind "knowledge"', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/compiler/compile', { kind: 'knowledge', graph: {} });
    assert.equal(res.status, 501);
  } finally {
    await server.stop();
  }
});

test('POST /compiler/compile returns 501 for kind "capability"', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/compiler/compile', { kind: 'capability', graph: {} });
    assert.equal(res.status, 501);
  } finally {
    await server.stop();
  }
});

test('POST /compiler/compile returns 501 for kind "combined"', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/compiler/compile', { kind: 'combined' });
    assert.equal(res.status, 501);
  } finally {
    await server.stop();
  }
});

test('POST /compiler/compile returns 400 for a missing "kind"', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/compiler/compile', {});
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test('POST /compiler/compile returns 400 for an empty body', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/compiler/compile', Buffer.alloc(0));
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});

test('POST /compiler/compile returns 400 for malformed JSON', async () => {
  const server = await TestServer.start();
  try {
    const res = await server.request('POST', '/compiler/compile', Buffer.from('{not json'));
    assert.equal(res.status, 400);
  } finally {
    await server.stop();
  }
});
