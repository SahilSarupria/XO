import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, LATEST_PROTOCOL_VERSION, McpError, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, MCP_SERVER_NAME } from '../src/server.js';
import { approvedDetail, FakeApi } from './fake-api.js';

async function connected(api: FakeApi): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({ api, sessionNonce: 'NONCE' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

test('handshake: initialize negotiates the latest revision, advertises ONLY tools, and identifies the server', async () => {
  const { client, close } = await connected(new FakeApi());
  try {
    assert.equal(client.getServerVersion()?.name, MCP_SERVER_NAME);
    assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
    const caps = client.getServerCapabilities();
    assert.deepEqual(Object.keys(caps ?? {}).sort(), ['tools']);
    assert.equal(caps?.tools?.listChanged, false);
    assert.equal(caps?.resources, undefined);
    assert.equal(caps?.prompts, undefined);
    assert.equal(caps?.logging, undefined);
    assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(LATEST_PROTOCOL_VERSION));
  } finally {
    await close();
  }
});

test('discovery over the protocol: tools/list shows the approved version with a closed schema; no start was issued', async () => {
  const api = new FakeApi();
  const { client, close } = await connected(api);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    const t = tools[0]!;
    assert.equal(t.name, 'pay.v1');
    assert.equal(t.inputSchema.type, 'object');
    assert.equal((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, false);
    assert.deepEqual(t.inputSchema.required, ['amount']);
    assert.match(t.description ?? '', /grants no authority/);
    assert.equal(api.starts().length, 0, 'discovery alone neither authorizes nor executes');
    assert.ok(api.calls.every((c) => c.op !== 'start'));
  } finally {
    await close();
  }
});

test('invocation over the protocol: structured result, derived idempotency key, API re-read each call', async () => {
  const api = new FakeApi();
  const { client, close } = await connected(api);
  try {
    const res = await client.callTool({ name: 'pay.v1', arguments: { amount: 12 } });
    assert.equal(res.isError, false);
    assert.equal((res.structuredContent as Record<string, unknown>)['outcome'], 'completed');
    const key = api.starts()[0]?.args[3] as string;
    assert.match(key, /^mcp-NONCE-[0-9]+$/);
    assert.match(key, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/, 'satisfies the API Idempotency-Key grammar');
    await client.callTool({ name: 'pay.v1', arguments: { amount: 13 } });
    assert.notEqual(api.starts()[1]?.args[3], key, 'a distinct request id is a distinct key');
    assert.equal(api.calls.filter((c) => c.op === 'get').length, 2);
  } finally {
    await close();
  }
});

test('protocol errors: unknown tool is -32602; unsupported MCP features are -32601; none reach the API start', async () => {
  const api = new FakeApi();
  api.get = (id, v) =>
    id === 'pay'
      ? { kind: 'ok', status: 200, body: approvedDetail(id, v) }
      : { kind: 'api_error', status: 404, code: 'XO_NOT_FOUND', message: 'procedure' };
  const { client, close } = await connected(api);
  try {
    await assert.rejects(
      client.callTool({ name: 'nope.v1', arguments: {} }),
      (e: unknown) => e instanceof McpError && e.code === ErrorCode.InvalidParams,
    );
    await assert.rejects(
      client.callTool({ name: 'pay', arguments: {} }),
      (e: unknown) => e instanceof McpError && e.code === ErrorCode.InvalidParams,
    );
    for (const method of ['resources/list', 'prompts/list', 'resources/read', 'prompts/get', 'logging/setLevel', 'completion/complete']) {
      await assert.rejects(
        client.request({ method, params: {} } as never, z.any()),
        (e: unknown) => e instanceof McpError && e.code === ErrorCode.MethodNotFound,
        method,
      );
    }
    assert.equal(api.starts().length, 0);
  } finally {
    await close();
  }
});

test('there is no approval (or any other) tool beyond approved procedure versions', async () => {
  const { client, close } = await connected(new FakeApi());
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.every((n) => /^[A-Za-z][A-Za-z0-9_-]*\.v[1-9][0-9]*$/.test(n)));
    assert.equal(
      names.some((n) => /approve|approval|reconcile|resume|grant/i.test(n)),
      false,
    );
    await assert.rejects(client.callTool({ name: 'approve', arguments: {} }), McpError);
  } finally {
    await close();
  }
});

test('discovery failure is a protocol error, not an empty tool list', async () => {
  const api = new FakeApi();
  api.list = { kind: 'api_error', status: 401, code: 'XO_AUTH_KEY_INVALID', message: 'API key is not recognized' };
  const { client, close } = await connected(api);
  try {
    await assert.rejects(
      client.listTools(),
      (e: unknown) => e instanceof McpError && /HTTP 401/.test(e.message) && !/xoak_/.test(e.message),
    );
  } finally {
    await close();
  }
});

test('client cancellation mid-call: the adapter aborts the request and never reports success or a safe failure', async () => {
  const api = new FakeApi();
  let observed: AbortSignal | undefined;
  api.start = (_i, _k, signal) =>
    new Promise((resolve) => {
      observed = signal;
      signal.addEventListener('abort', () => resolve({ kind: 'no_answer', reason: 'cancelled' }));
    });
  const { client, close } = await connected(api);
  try {
    const ac = new AbortController();
    const pending = client.callTool({ name: 'pay.v1', arguments: { amount: 1 } }, undefined, { signal: ac.signal });
    while (observed === undefined) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await assert.rejects(pending);
    assert.equal(observed.aborted, true, 'the in-flight API request was aborted');
    assert.equal(api.starts().length, 1, 'no retry');
  } finally {
    await close();
  }
});
