import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFsBlobStore } from '@xo/storage';
import type { AuditEvent } from '@xo/audit';
import { withTempDir } from './test-helpers.js';
import { FsApiKeyStore } from '../src/auth/fs-api-key-store.js';
import { generateApiKey, hashApiKey } from '../src/auth/api-key.js';

// P1.0 M4 acceptance evidence — the REAL process entrypoint (apps/api/src/index.ts) with real XO_AUDIT_* environment variables.
// Each test spawns a child process with an explicit, minimal environment (nothing is inherited, so no real audit data,
// API keys or operator configuration can be touched), pointing every directory at a temp dir that is removed afterwards.

const API_DIR = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = join(API_DIR, 'src', 'index.ts');

interface Child {
  readonly proc: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<number | null>;
}

function launch(env: Record<string, string>): Child {
  let out = '';
  const proc = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
    cwd: API_DIR,
    // Explicit environment only: PATH is needed to resolve nothing here, but harmless; everything XO-related is set by the test.
    env: { PATH: process.env['PATH'] ?? '', HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<number | null>((resolve) => proc.on('exit', (code) => resolve(code)));
  return { proc, output: () => out, exited };
}

async function stop(child: Child): Promise<void> {
  if (child.proc.exitCode === null && child.proc.signalCode === null) {
    child.proc.kill('SIGKILL');
    await child.exited;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function request(port: number, method: string, path: string, key: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          authorization: `Bearer ${key}`,
          ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, json: text.length > 0 ? (JSON.parse(text) as unknown) : undefined });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const dirsEnv = (root: string): Record<string, string> => ({
  API_KEYS_DIR: join(root, 'keys'),
  WORKSPACES_DIR: join(root, 'workspaces'),
  WORKSPACE_DATA_DIR: join(root, 'data'),
});

test('startup: NODE_ENV=production with no XO_AUDIT_* aborts before opening a socket (exit 1, explicit message, nothing written)', async () => {
  await withTempDir('xo-startup-', async (root) => {
    const port = await freePort();
    const child = launch({ ...dirsEnv(root), PORT: String(port), NODE_ENV: 'production' });
    try {
      const code = await Promise.race([child.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
      assert.equal(code, 1, child.output());
      assert.match(child.output(), /startup aborted/);
      assert.match(child.output(), /XO_AUDIT_DIR/);
      assert.ok(!child.output().includes('listening on'));
    } finally {
      await stop(child);
    }
  });
});

test('startup: a partial XO_AUDIT_* configuration aborts startup (exit 1) rather than running with a guessed retention', async () => {
  await withTempDir('xo-startup-', async (root) => {
    const port = await freePort();
    const child = launch({
      ...dirsEnv(root),
      PORT: String(port),
      NODE_ENV: 'development',
      XO_TRUST_MODE: 'development',
      XO_AUDIT_DIR: join(root, 'audit'),
      XO_AUDIT_RETENTION_DAYS: '30',
      // XO_AUDIT_MIN_RETENTION_DAYS deliberately missing
    });
    try {
      const code = await Promise.race([child.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 30_000))]);
      assert.equal(code, 1, child.output());
      assert.match(child.output(), /must all be set together/);
      assert.ok(!child.output().includes('listening on'));
    } finally {
      await stop(child);
    }
  });
});

test('startup: full XO_AUDIT_* configuration opens the durable store through the real entrypoint — a protected read is recorded in audit.jsonl and the volatile-mode warning is absent', async () => {
  await withTempDir('xo-startup-', async (root) => {
    const dirs = dirsEnv(root);
    const key = generateApiKey();
    const created = await new FsApiKeyStore(new LocalFsBlobStore(dirs['API_KEYS_DIR'] as string)).create({
      keyHash: hashApiKey(key),
      identityId: 'startup-identity',
      principalKind: 'service',
      createdAt: new Date().toISOString(),
    });
    assert.ok(created.ok);
    const auditDir = join(root, 'audit');
    const port = await freePort();
    const child = launch({
      ...dirs,
      PORT: String(port),
      NODE_ENV: 'development',
      XO_TRUST_MODE: 'development',
      XO_AUDIT_DIR: auditDir,
      XO_AUDIT_RETENTION_DAYS: '30',
      XO_AUDIT_MIN_RETENTION_DAYS: '7',
    });
    try {
      await waitFor(() => child.output().includes('listening on') || child.proc.exitCode !== null, 30_000, 'startup');
      assert.equal(child.proc.exitCode, null, child.output());
      assert.ok(!child.output().includes('NON-PRODUCTION'), 'durable mode: no volatile-audit warning');

      const ws = await request(port, 'POST', '/workspaces', key, {});
      assert.equal(ws.status, 201, JSON.stringify(ws.json));
      const workspaceId = (ws.json as { workspaceId: string }).workspaceId;
      const list = await request(port, 'GET', `/workspaces/${workspaceId}/executions`, key);
      assert.equal(list.status, 200, JSON.stringify(list.json));

      const lines = (await readFile(join(auditDir, 'audit.jsonl'), 'utf8')).split('\n').filter((l) => l.length > 0);
      const events = lines.map((l) => JSON.parse(l) as AuditEvent);
      const read = events.find((e) => e.type === 'access.attempted' && e.action === 'list.executions');
      assert.ok(read, `access.attempted recorded by the spawned server (got ${events.map((e) => e.type).join(',')})`);
      assert.equal(read.actor.id, 'startup-identity');
      assert.ok(
        Date.parse(read.retainUntil) - Date.parse(read.recordedAt) >= 29 * 86_400_000,
        'the configured 30-day retention was applied',
      );
      assert.ok(!child.output().includes(key), 'the API key never reaches process output');
    } finally {
      await stop(child);
    }
  });
});
