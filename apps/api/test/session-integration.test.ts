import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withTempDir } from './test-helpers.js';
import { TestIdp } from './oidc-test-idp.js';

/**
 * Google sign-in → XO session at the real HTTP boundary: the BUILT API (`dist/index.js`) as a child process, configured
 * only through its environment, in front of a local test issuer that stands in for Google (generated keys, loopback
 * http). Proves the wiring, startup validation, persistence across a process restart, the operator CLI, and that
 * nothing credential-shaped reaches the process output. It does NOT prove anything about the real Google service.
 */

const run = promisify(execFile);
const APP_DIR = resolve(import.meta.dirname, '..');
const ROOT = resolve(APP_DIR, '..', '..');
const ENTRY = join(APP_DIR, 'dist', 'index.js');
const CLIENT_ID = '1234567890-xotest.apps.googleusercontent.com';

let built = false;
async function ensureBuilt(): Promise<void> {
  if (built) return;
  await run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', join(APP_DIR, 'tsconfig.json')], {
    cwd: ROOT,
    timeout: 240_000,
  });
  assert.ok(existsSync(ENTRY), 'apps/api/dist/index.js exists after the build');
  built = true;
}

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => (addr !== null && typeof addr !== 'string' ? res(addr.port) : rej(new Error('no port'))));
    });
  });
}

const children = new Set<ChildProcess>();
after(() => {
  for (const c of children) c.kill('SIGKILL');
});

interface Api {
  readonly base: string;
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

async function startApi(env: Record<string, string>): Promise<Api> {
  await ensureBuilt();
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      XO_API_OIDC_ISSUER: '',
      XO_API_OIDC_AUDIENCE: '',
      XO_API_GOOGLE_CLIENT_ID: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let out = '';
  child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
  for (let i = 0; i < 100 && !out.includes('listening'); i++) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(out.includes('listening'), 'the API process started and reported that it is listening');
  return {
    base: `http://127.0.0.1:${port}`,
    output: () => out,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((r) => (child.exitCode !== null ? r(undefined) : child.once('exit', r)));
      children.delete(child);
    },
  };
}

async function script(name: string, args: string[], env: Record<string, string>): Promise<string> {
  const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', join('scripts', name), ...args], {
    cwd: APP_DIR,
    env: { ...process.env, ...env },
  });
  return stdout + stderr;
}

interface Res {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
}
async function call(api: Api, method: string, path: string, bearer?: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${api.base}${path}`, {
    method,
    headers: {
      ...(bearer !== undefined ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
const errCode = (r: Res): string | undefined => (JSON.parse(r.text) as { error?: { code?: string } }).error?.code;

test('startup: Google sign-in settings without a client id, or an invalid client id or issuer, refuse to start', async () => {
  await ensureBuilt();
  const attempts: Array<[Record<string, string>, RegExp]> = [
    [{ XO_API_GOOGLE_ISSUER: 'https://accounts.google.com' }, /XO_API_GOOGLE_ISSUER.*without XO_API_GOOGLE_CLIENT_ID/],
    [{ XO_API_SESSIONS_DIR: '/tmp/x' }, /XO_API_SESSIONS_DIR.*without XO_API_GOOGLE_CLIENT_ID/],
    [{ XO_API_GOOGLE_CLIENT_ID: 'has space' }, /XO_API_GOOGLE_CLIENT_ID/],
    [{ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_ISSUER: 'http://accounts.example' }, /XO_API_GOOGLE_ISSUER/],
  ];
  for (const [env, expected] of attempts) {
    let output = '';
    let failed = false;
    try {
      const r = await run(process.execPath, [ENTRY], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(await freePort()), HOST: '127.0.0.1', XO_API_GOOGLE_CLIENT_ID: '', ...env },
        timeout: 15_000,
      });
      output = r.stdout + r.stderr;
    } catch (e) {
      failed = true;
      const err = e as { code?: number; stdout?: string; stderr?: string };
      output = (err.stdout ?? '') + (err.stderr ?? '');
      assert.ok(typeof err.code === 'number' && err.code !== 0);
    }
    assert.ok(failed, 'the process must not start');
    assert.match(output, expected);
  }
});

test('sign-in disabled by default: the endpoints do not exist, and API keys work as before', async () => {
  await withTempDir('xo-sint-off-', async (tmp) => {
    const env = { API_KEYS_DIR: join(tmp, 'keys'), WORKSPACES_DIR: join(tmp, 'ws'), WORKSPACE_DATA_DIR: join(tmp, 'wsd') };
    const issued = await script('manage-keys.ts', ['issue', 'svc-1', '--kind', 'service'], env);
    const apiKey = /xoak_[A-Za-z0-9_-]+/.exec(issued)?.[0];
    assert.ok(apiKey);
    const api = await startApi(env);
    try {
      assert.equal((await call(api, 'POST', '/auth/login-challenge', undefined, {})).status, 404);
      assert.equal((await call(api, 'POST', '/auth/session', undefined, {})).status, 404);
      assert.equal(
        errCode(await call(api, 'GET', '/workspaces', `xoas_${'A'.repeat(43)}`)),
        'XO_AUTH_KEY_INVALID',
        'session credentials are not recognised when sign-in is off',
      );
      assert.equal((await call(api, 'GET', '/workspaces', apiKey)).status, 200);
    } finally {
      await api.stop();
    }
  });
});

test('end to end against the built API: sign in, call, refresh, restart, unbound discovery, bind, revoke, logout; no secret in process output', async () => {
  await withTempDir('xo-sint-on-', async (tmp) => {
    const sessionsDir = join(tmp, 'sessions');
    const bindDir = join(tmp, 'bindings');
    const env = {
      API_KEYS_DIR: join(tmp, 'keys'),
      WORKSPACES_DIR: join(tmp, 'ws'),
      WORKSPACE_DATA_DIR: join(tmp, 'wsd'),
      XO_API_OIDC_BINDINGS_DIR: bindDir,
      XO_API_SESSIONS_DIR: sessionsDir,
    };
    const idp = await TestIdp.start();
    const apiEnv = { ...env, XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_ISSUER: idp.issuer };
    const issued = await script('manage-keys.ts', ['issue', 'svc-1', '--kind', 'service'], env);
    const apiKey = /xoak_[A-Za-z0-9_-]+/.exec(issued)?.[0];
    assert.ok(apiKey);
    let api = await startApi(apiEnv);
    const secrets: string[] = [];
    const signIn = async (sub: string): Promise<Res> => {
      const ch = JSON.parse((await call(api, 'POST', '/auth/login-challenge', undefined, {})).text) as {
        challengeId: string;
        nonce: string;
      };
      const idToken = await idp.sign({ sub, aud: CLIENT_ID, claims: { nonce: ch.nonce, email: 'must-not-leak@example.com' } });
      secrets.push(ch.challengeId, ch.nonce, idToken);
      return call(api, 'POST', '/auth/session', undefined, { challengeId: ch.challengeId, idToken });
    };
    try {
      // Unbound: refused, and discoverable by the operator (and only there).
      const refused = await signIn('g-alice');
      assert.equal(refused.status, 401);
      assert.equal(errCode(refused), 'XO_AUTH_IDENTITY_UNBOUND');
      const listing = await script('manage-oidc-bindings.ts', ['unbound'], env);
      assert.match(listing, new RegExp(`issuer=${JSON.stringify(idp.issuer).replace(/[/.]/g, '\\$&')}\\s+subject="g-alice"`));
      assert.ok(!listing.includes('must-not-leak@example.com'));
      assert.equal((await call(api, 'GET', '/auth/unbound')).status, 404);

      // Explicit operator action binds it (and clears the discovery entry).
      await script(
        'manage-oidc-bindings.ts',
        ['bind', '--issuer', idp.issuer, '--subject', 'g-alice', '--identity', 'alice', '--kind', 'human'],
        env,
      );
      assert.match(await script('manage-oidc-bindings.ts', ['unbound'], env), /no recent unbound/);

      const ok = await signIn('g-alice');
      assert.equal(ok.status, 201);
      const session = JSON.parse(ok.text) as { accessCredential: string; refreshCredential: string };
      secrets.push(session.accessCredential, session.refreshCredential);
      const created = await call(api, 'POST', '/workspaces', session.accessCredential, { identityId: 'root' });
      assert.equal(created.status, 201);
      const wsId = (JSON.parse(created.text) as { workspaceId: string }).workspaceId;
      assert.equal((await call(api, 'GET', `/workspaces/${wsId}`, apiKey)).status, 404, 'the API-key principal does not own it');

      // Restart the process: the session survives (state is on disk, not in memory).
      await api.stop();
      api = await startApi(apiEnv);
      assert.equal((await call(api, 'GET', `/workspaces/${wsId}`, session.accessCredential)).status, 200, 'session survives a restart');
      const rotated = await call(api, 'POST', '/auth/refresh', undefined, { refreshCredential: session.refreshCredential });
      assert.equal(rotated.status, 200);
      const next = JSON.parse(rotated.text) as { accessCredential: string; refreshCredential: string };
      secrets.push(next.accessCredential, next.refreshCredential);
      assert.equal(
        (await call(api, 'POST', '/auth/refresh', undefined, { refreshCredential: session.refreshCredential })).status,
        401,
        'replay of the used refresh credential',
      );
      assert.equal((await call(api, 'GET', `/workspaces/${wsId}`, next.accessCredential)).status, 401, 'reuse revoked the family');

      // Sign in again, then revoke the binding with the operator CLI: the next request fails.
      const again = JSON.parse((await signIn('g-alice')).text) as { accessCredential: string; refreshCredential: string };
      secrets.push(again.accessCredential, again.refreshCredential);
      assert.equal((await call(api, 'GET', '/workspaces', again.accessCredential)).status, 200);
      await script('manage-oidc-bindings.ts', ['revoke', '--issuer', idp.issuer, '--subject', 'g-alice'], env);
      const afterRevoke = await call(api, 'GET', '/workspaces', again.accessCredential);
      assert.equal(afterRevoke.status, 401);
      assert.equal(errCode(afterRevoke), 'XO_AUTH_IDENTITY_UNBOUND');

      // Re-bind, sign in, log out.
      await script(
        'manage-oidc-bindings.ts',
        ['bind', '--issuer', idp.issuer, '--subject', 'g-alice', '--identity', 'alice', '--kind', 'human'],
        env,
      );
      const third = JSON.parse((await signIn('g-alice')).text) as { accessCredential: string; refreshCredential: string };
      secrets.push(third.accessCredential, third.refreshCredential);
      assert.equal((await call(api, 'POST', '/auth/logout', third.accessCredential, {})).status, 204);
      assert.equal((await call(api, 'GET', '/workspaces', third.accessCredential)).status, 401);
      assert.equal((await call(api, 'POST', '/auth/refresh', undefined, { refreshCredential: third.refreshCredential })).status, 401);

      // Rate limiting is live in the built process: a burst of exchanges is cut off.
      let limited = 0;
      for (let i = 0; i < 14; i++)
        if ((await call(api, 'POST', '/auth/session', undefined, { challengeId: 'x'.repeat(43), idToken: 'a.b.c' })).status === 429)
          limited++;
      assert.ok(limited > 0, 'the exchange endpoint is rate limited');

      // Disk: private files, no plaintext credentials; process output free of secrets.
      const listAll = async (dir: string): Promise<string[]> =>
        (await readdir(dir, { withFileTypes: true })).flatMap((e) => (e.isDirectory() ? [] : [join(dir, e.name)]));
      const sampleDir = join(sessionsDir, 'sessions', 'access');
      for (const f of await listAll(sampleDir)) {
        assert.equal((await stat(f)).mode & 0o777, 0o600);
        const text = await readFile(f, 'utf8');
        for (const s of secrets) assert.ok(!text.includes(s), 'plaintext credential on disk');
      }
      const out = api.output();
      for (const s of secrets) assert.ok(!out.includes(s), 'a secret appears in the API process output');
      assert.ok(!out.includes('must-not-leak@example.com'));
      assert.ok(!out.toLowerCase().includes('authorization'));
    } finally {
      await api.stop();
      await idp.stop();
    }
  });
});
