import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpXoApi, MAX_RESPONSE_BYTES } from '../src/api-client.js';
import { loadConfig } from '../src/config.js';

const KEY = 'xoak_0123456789abcdefghijklmnopqrstuvwxyz';
const sig = new AbortController().signal;

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
const api = (base: string, timeout = '5000'): HttpXoApi =>
  new HttpXoApi(loadConfig({ XO_API_KEY: KEY, XO_API_URL: base, XO_WORKSPACE_ID: 'ws_1', XO_MCP_REQUEST_TIMEOUT_MS: timeout }));

test('http: requests carry the bearer credential from config, the right route, and the idempotency key; the body is the input only', async () => {
  const seen: { method?: string; url?: string; auth?: string; idem?: string; body: string }[] = [];
  await withServer(
    (req, res, body) => {
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers['authorization'],
        idem: req.headers['idempotency-key'] as string,
        body,
      });
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
    },
    async (base) => {
      const a = api(base);
      assert.deepEqual(await a.listProcedures(sig), { kind: 'ok', status: 201, body: { ok: true } });
      await a.getProcedure('pay', 2, sig);
      await a.startProcedure('pay', 2, { amount: 3 }, 'mcp-key-0001', sig);
    },
  );
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => s.auth === `Bearer ${KEY}`));
  assert.equal(seen[0]?.url, '/workspaces/ws_1/procedures');
  assert.equal(seen[1]?.url, '/workspaces/ws_1/procedures/pay?version=2');
  assert.equal(seen[2]?.method, 'POST');
  assert.equal(seen[2]?.url, '/workspaces/ws_1/procedures/pay/versions/2/executions');
  assert.equal(seen[2]?.idem, 'mcp-key-0001');
  assert.deepEqual(JSON.parse(seen[2]?.body ?? ''), { input: { amount: 3 } });
});

test('http: API error bodies are passed through as code/message only; non-JSON error bodies yield no detail', async () => {
  await withServer(
    (req, res) => {
      if (req.url === '/workspaces/ws_1/procedures')
        res
          .writeHead(403, { 'content-type': 'application/json' })
          .end('{"error":{"code":"XO_RUNTIME_PERMISSION_DENIED","message":"nope","context":{"secret":"x"}}}');
      else res.writeHead(502).end('<html>bad gateway</html>');
    },
    async (base) => {
      assert.deepEqual(await api(base).listProcedures(sig), {
        kind: 'api_error',
        status: 403,
        code: 'XO_RUNTIME_PERMISSION_DENIED',
        message: 'nope',
      });
      assert.deepEqual(await api(base).getProcedure('p', 1, sig), { kind: 'api_error', status: 502, code: undefined, message: undefined });
    },
  );
});

test('http: timeout, abort, network failure, redirect and oversized/garbled replies are "no answer", never a status', async () => {
  await withServer(
    (req, res) => {
      if (req.url?.includes('/slow')) return; // never answers
      if (req.url?.includes('/redirect')) return void res.writeHead(302, { location: 'http://127.0.0.1:1/steal' }).end();
      if (req.url?.includes('/big'))
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(`"${'a'.repeat(MAX_RESPONSE_BYTES + 10)}"`);
      res.writeHead(200).end('not json');
    },
    async (base) => {
      const a = api(base, '1000');
      assert.deepEqual(await a.getProcedure('slow', 1, sig), { kind: 'no_answer', reason: 'timeout' });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 50);
      assert.deepEqual(await a.getProcedure('slow', 1, ac.signal), { kind: 'no_answer', reason: 'cancelled' });
      assert.equal((await a.getProcedure('redirect', 1, sig)).kind, 'no_answer');
      assert.deepEqual(await a.getProcedure('big', 1, sig), { kind: 'no_answer', reason: 'unreadable_response' });
      assert.deepEqual(await a.getProcedure('garbled', 1, sig), { kind: 'no_answer', reason: 'unreadable_response' });
    },
  );
  const dead = new HttpXoApi(loadConfig({ XO_API_KEY: KEY, XO_API_URL: 'http://127.0.0.1:1', XO_WORKSPACE_ID: 'ws_1' }));
  assert.deepEqual(await dead.listProcedures(sig), { kind: 'no_answer', reason: 'network' });
});
