import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const KEY = 'xoak_0123456789abcdefghijklmnopqrstuvwxyz';
const SCHEMA = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false };

interface Proc {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdoutLines: string[];
  stderr: string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  send(line: string): void;
  waitFor(pred: (m: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
}

function spawnMain(env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ['--import', 'tsx', MAIN], { env: { PATH: process.env['PATH'] ?? '', ...env }, stdio: 'pipe' });
  const stdoutLines: string[] = [];
  let buf = '';
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      stdoutLines.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  const proc: Proc = {
    child,
    stdoutLines,
    stderr: '',
    exited: new Promise((r) => child.on('exit', (code, signal) => r({ code, signal }))),
    send: (line) => void child.stdin.write(`${line}\n`),
    waitFor: async (pred, ms = 20_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        for (const l of stdoutLines) {
          const m = JSON.parse(l) as Record<string, unknown>;
          if (pred(m)) return m;
        }
        if (Date.now() > deadline) throw new Error(`timeout waiting for message; stdout=${JSON.stringify(stdoutLines)}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
  child.stderr.on('data', (d: Buffer) => (proc.stderr += d.toString('utf8')));
  return proc;
}

async function withApi(fn: (base: string, hits: string[]) => Promise<void>): Promise<void> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/workspaces/ws_1/procedures') {
      return void res.end(JSON.stringify({ procedures: [{ procedureId: 'pay', versions: [{ version: 1, lifecycle: 'approved' }] }] }));
    }
    if (req.url?.startsWith('/workspaces/ws_1/procedures/pay?')) {
      return void res.end(
        JSON.stringify({ procedureId: 'pay', version: 1, lifecycle: 'approved', inputSchema: SCHEMA, definition: { title: 'Pay' } }),
      );
    }
    res.statusCode = 201;
    res.end(JSON.stringify({ procedureExecutionId: 'pex_1', status: 'completed', steps: [], outputs: {} }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});

test('stdio: missing XO_API_KEY fails closed (exit 2), writes NOTHING to stdout, and names the variable only', async () => {
  const p = spawnMain({ XO_API_URL: 'http://127.0.0.1:1', XO_WORKSPACE_ID: 'ws_1' });
  const { code } = await p.exited;
  assert.equal(code, 2);
  assert.deepEqual(p.stdoutLines, []);
  assert.match(p.stderr, /XO_API_KEY is required/);
});

test('stdio: a malformed key is rejected without echoing it; the credential never appears on stdout or stderr in any run', async () => {
  const bad = 'bad key with spaces';
  const p = spawnMain({ XO_API_KEY: bad, XO_API_URL: 'http://127.0.0.1:1', XO_WORKSPACE_ID: 'ws_1' });
  assert.equal((await p.exited).code, 2);
  assert.equal(p.stderr.includes(bad), false);
  assert.deepEqual(p.stdoutLines, []);
});

test('stdio: full session over a real process — handshake, list, call; stdout carries ONLY JSON-RPC frames; stderr carries diagnostics without secrets; EOF shuts down with exit 0', async () => {
  await withApi(async (base, hits) => {
    const p = spawnMain({ XO_API_KEY: KEY, XO_API_URL: base, XO_WORKSPACE_ID: 'ws_1' });
    p.send(INIT);
    const init = await p.waitFor((m) => m['id'] === 1);
    const result = init['result'] as { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } };
    assert.equal(result.protocolVersion, '2025-11-25');
    assert.deepEqual(Object.keys(result.capabilities), ['tools']);
    p.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    assert.deepEqual(hits, [], 'the handshake alone makes no API request');

    p.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    const list = await p.waitFor((m) => m['id'] === 2);
    assert.equal((list['result'] as { tools: { name: string }[] }).tools[0]?.name, 'pay.v1');
    assert.equal(
      hits.some((h) => h.startsWith('POST')),
      false,
      'discovery issued no start request',
    );

    p.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pay.v1', arguments: { amount: 9 } } }));
    const call = await p.waitFor((m) => m['id'] === 3);
    assert.equal((call['result'] as { isError: boolean }).isError, false);
    assert.equal(hits.filter((h) => h.startsWith('POST')).length, 1);

    // stdout purity: every line is a JSON-RPC 2.0 frame.
    for (const l of p.stdoutLines) assert.equal((JSON.parse(l) as { jsonrpc: string }).jsonrpc, '2.0');
    assert.equal(p.stdoutLines.join('').includes(KEY), false);

    p.child.stdin.end();
    const { code } = await p.exited;
    assert.equal(code, 0, 'EOF on stdin is a clean shutdown');
    assert.equal(p.stderr.includes(KEY), false);
    assert.equal(p.stderr.includes('amount'), false, 'arguments are never logged');
    assert.match(p.stderr, /"event":"started"/);
    assert.match(p.stderr, /"event":"stopped"/);
  });
});

test('stdio: malformed input does not crash the server or pollute stdout; later requests still work', async () => {
  await withApi(async (base) => {
    const p = spawnMain({ XO_API_KEY: KEY, XO_API_URL: base, XO_WORKSPACE_ID: 'ws_1' });
    p.send(INIT);
    await p.waitFor((m) => m['id'] === 1);
    p.send('{this is not json');
    p.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 5 } }));
    p.send(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'no/such/method' }));
    const bad = await p.waitFor((m) => m['id'] === 7);
    // The SDK reports a schema-invalid tools/call as an error response (-32603 in this SDK version; JSON-RPC would prefer -32602).
    assert.ok([-32602, -32603].includes((bad['error'] as { code: number }).code));
    const nf = await p.waitFor((m) => m['id'] === 8);
    assert.equal((nf['error'] as { code: number }).code, -32601);
    p.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }));
    assert.ok(await p.waitFor((m) => m['id'] === 9 && m['result'] !== undefined));
    for (const l of p.stdoutLines) assert.equal((JSON.parse(l) as { jsonrpc: string }).jsonrpc, '2.0');
    p.child.stdin.end();
    assert.equal((await p.exited).code, 0);
  });
});

test('stdio: SIGTERM shuts down cleanly (exit 0) and an unreachable API yields a protocol error, not a hang or an empty list', async () => {
  const p = spawnMain({ XO_API_KEY: KEY, XO_API_URL: 'http://127.0.0.1:1', XO_WORKSPACE_ID: 'ws_1', XO_MCP_REQUEST_TIMEOUT_MS: '2000' });
  p.send(INIT);
  await p.waitFor((m) => m['id'] === 1);
  p.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  const failed = await p.waitFor((m) => m['id'] === 2);
  assert.ok(failed['error'], 'discovery failure is an error response');
  assert.equal(failed['result'], undefined);
  p.child.kill('SIGTERM');
  const { code } = await p.exited;
  assert.equal(code, 0);
});
