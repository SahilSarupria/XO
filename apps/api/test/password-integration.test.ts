import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { withTempDir } from './test-helpers.js';
import { TestIdp } from './oidc-test-idp.js';

/**
 * Password sign-in at the real process boundary: the BUILT API (`dist/index.js`) as a child process configured only
 * through its environment, driven by the real operator CLI. Proves startup validation, the whole account lifecycle
 * (create -> setup code -> sign in -> change -> operator reset -> disable), persistence across a restart, coexistence
 * with Google sign-in, and that no secret reaches the process output or any file. It uses a local test issuer in place
 * of Google and exercises no real mail service, identity provider or model provider.
 */

const run = promisify(execFile);
const APP_DIR = resolve(import.meta.dirname, '..');
const ROOT = resolve(APP_DIR, '..', '..');
const ENTRY = join(APP_DIR, 'dist', 'index.js');
const CLIENT_ID = '1234567890-xotest.apps.googleusercontent.com';
const PW = 'integration passphrase CANARY-8c41e2';
const PW2 = 'second integration passphrase CANARY-5d09';

let built = false;
async function ensureBuilt(): Promise<void> {
  if (built) return;
  await run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-b', join(APP_DIR, 'tsconfig.json')], {
    cwd: ROOT,
    timeout: 240_000,
  });
  assert.ok(existsSync(ENTRY));
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
  assert.ok(out.includes('listening'), `the API process started: ${out}`);
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

async function cli(args: string[], env: Record<string, string>): Promise<{ out: string; code: number }> {
  try {
    const r = await run(process.execPath, ['--import', 'tsx', join('scripts', 'manage-password-accounts.ts'), ...args], {
      cwd: APP_DIR,
      env: { ...process.env, ...env },
    });
    return { out: r.stdout + r.stderr, code: 0 };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { out: (err.stdout ?? '') + (err.stderr ?? ''), code: typeof err.code === 'number' ? err.code : 1 };
  }
}

interface Res {
  readonly status: number;
  readonly text: string;
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
  return { status: r.status, text: await r.text() };
}
interface Session {
  accessCredential: string;
  refreshCredential: string;
}
const session = (r: Res): Session => JSON.parse(r.text) as Session;
const setupCode = (out: string): string => /xot_[A-Za-z0-9_-]+/.exec(out)?.[0] ?? assert.fail(`no setup code in: ${out}`);

async function filesContaining(root: string, secrets: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else {
        const text = (await readFile(p)).toString('utf8');
        if (secrets.some((s) => text.includes(s))) hits.push(p);
      }
    }
  };
  await walk(root);
  return hits;
}

const FAST = { XO_API_PASSWORD_ARGON2_MEMORY_KIB: '19456', XO_API_PASSWORD_ARGON2_TIME_COST: '2' };

test('startup: partial or inconsistent password configuration refuses to start, naming the variable and never a value', async () => {
  await ensureBuilt();
  const attempts: Array<[Record<string, string>, RegExp]> = [
    [{ XO_API_ACCOUNTS_DIR: '/tmp/secret-looking-path-xyz' }, /XO_API_ACCOUNTS_DIR.*without XO_API_PASSWORD_AUTH/],
    [{ XO_API_PASSWORD_AUTH: '1', XO_API_PASSWORD_ARGON2_MEMORY_KIB: '2048' }, /XO_API_PASSWORD_ARGON2_MEMORY_KIB/],
    [{ XO_API_PASSWORD_AUTH: '1', XO_API_PASSWORD_ARGON2_TIME_COST: '1' }, /XO_API_PASSWORD_ARGON2_TIME_COST/],
    [
      {
        XO_API_PASSWORD_AUTH: '1',
        XO_API_GOOGLE_CLIENT_ID: CLIENT_ID,
        XO_API_SESSIONS_DIR: '/tmp/one',
        XO_API_PASSWORD_SESSIONS_DIR: '/tmp/two',
      },
      /must name the same directories/,
    ],
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
    }
    assert.ok(failed, `must not start: ${JSON.stringify(env)}`);
    assert.match(output, expected);
    assert.ok(!output.includes('secret-looking-path-xyz'), 'the value is never echoed');
  }
});

test('the operator CLI never takes a password and prints the setup code once', async () => {
  await withTempDir('xo-pwint-cli-', async (tmp) => {
    const env = {
      XO_API_ACCOUNTS_DIR: join(tmp, 'accounts'),
      XO_API_PASSWORD_SESSIONS_DIR: join(tmp, 's'),
      XO_API_PASSWORD_BINDINGS_DIR: join(tmp, 'b'),
    };
    const refused = await cli(['create', '--login', 'meera', '--identity', 'meera-id', '--password', 'hunter2hunter2'], env);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /never takes a password/);
    assert.ok(!refused.out.includes('hunter2'));

    const created = await cli(['create', '--login', 'Meera', '--identity', 'meera-id'], env);
    assert.equal(created.code, 0, created.out);
    assert.match(created.out, /operator-assisted|no self-service/);
    const code = setupCode(created.out);
    assert.equal((await cli(['create', '--login', 'meera', '--identity', 'other'], env)).code, 1, 'duplicate login names are refused');
    const listing = await cli(['list'], env);
    assert.match(listing.out, /"meera".*password=not set.*code outstanding/);
    assert.ok(!listing.out.includes(code), 'the code is shown once and never listed again');
    assert.equal((await cli(['reset', '--login', 'nobody'], env)).code, 1);
    assert.equal((await cli(['bogus'], env)).code, 1);
  });
});

test('password-only deployment end to end: setup, sign in, use, change, operator reset, disable, restart; nothing secret in output or files', async () => {
  await withTempDir('xo-pwint-', async (tmp) => {
    const env = {
      API_KEYS_DIR: join(tmp, 'keys'),
      WORKSPACES_DIR: join(tmp, 'ws'),
      WORKSPACE_DATA_DIR: join(tmp, 'wsd'),
      XO_API_PASSWORD_AUTH: '1',
      XO_API_ACCOUNTS_DIR: join(tmp, 'accounts'),
      XO_API_PASSWORD_SESSIONS_DIR: join(tmp, 'sessions'),
      XO_API_PASSWORD_BINDINGS_DIR: join(tmp, 'bindings'),
      ...FAST,
    };
    const secrets: string[] = [PW, PW2];
    let api = await startApi(env);
    try {
      const created = await cli(['create', '--login', 'meera', '--identity', 'meera-id'], env);
      const code = setupCode(created.out);
      secrets.push(code);

      assert.equal(
        (await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'meera', password: PW })).status,
        401,
        'no password yet',
      );
      assert.equal((await call(api, 'POST', '/auth/password/setup', undefined, { token: code, newPassword: PW })).status, 200);
      assert.equal((await call(api, 'POST', '/auth/password/setup', undefined, { token: code, newPassword: PW2 })).status, 401, 'replay');

      const first = session(await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'meera', password: PW }));
      secrets.push(first.accessCredential, first.refreshCredential);
      const ws = await call(api, 'POST', '/workspaces', first.accessCredential, { name: 'm' });
      assert.equal(ws.status, 201);
      assert.equal((JSON.parse(ws.text) as { identityId: string }).identityId, 'meera-id');

      // Restart: sessions and accounts are on disk, not in memory.
      await api.stop();
      api = await startApi(env);
      assert.equal((await call(api, 'GET', '/workspaces', first.accessCredential)).status, 200, 'session survives a restart');
      const refreshed = session(await call(api, 'POST', '/auth/refresh', undefined, { refreshCredential: first.refreshCredential }));
      secrets.push(refreshed.accessCredential, refreshed.refreshCredential);

      // Change password: the old session dies, the new one lives.
      const changed = await call(api, 'POST', '/auth/password/change', refreshed.accessCredential, {
        currentPassword: PW,
        newPassword: PW2,
      });
      assert.equal(changed.status, 200, changed.text);
      const afterChange = session(changed);
      secrets.push(afterChange.accessCredential, afterChange.refreshCredential);
      assert.equal((await call(api, 'GET', '/workspaces', refreshed.accessCredential)).status, 401);
      assert.equal((await call(api, 'GET', '/workspaces', afterChange.accessCredential)).status, 200);

      // Operator-assisted recovery: the operator issues a code; nothing changes until it is redeemed; redeeming ends every session.
      const reset = await cli(['reset', '--login', 'meera'], env);
      const resetCode = setupCode(reset.out);
      secrets.push(resetCode);
      assert.equal((await call(api, 'GET', '/workspaces', afterChange.accessCredential)).status, 200);
      assert.equal((await call(api, 'POST', '/auth/password/setup', undefined, { token: resetCode, newPassword: PW })).status, 200);
      assert.equal((await call(api, 'GET', '/workspaces', afterChange.accessCredential)).status, 401);
      const again = session(await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'meera', password: PW }));
      secrets.push(again.accessCredential, again.refreshCredential);

      // Disable: the live session stops on its next request; sign-in is refused identically to any other failure.
      assert.equal((await cli(['disable', '--login', 'meera'], env)).code, 0);
      assert.equal((await call(api, 'GET', '/workspaces', again.accessCredential)).status, 401);
      const refused = await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'meera', password: PW });
      const ghost = await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'ghost-account', password: PW });
      assert.equal(refused.status, 401);
      assert.equal(refused.text, ghost.text, 'a disabled account looks exactly like one that does not exist');
      assert.equal((await cli(['enable', '--login', 'meera'], env)).code, 0);
      assert.equal((await call(api, 'GET', '/workspaces', again.accessCredential)).status, 401, 'enabling does not revive an old session');
      assert.equal((await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'meera', password: PW })).status, 201);

      // No secret anywhere: not in what the server printed, not in the operator CLI output after the code was shown, not on disk.
      const printed = api.output();
      for (const s of secrets) assert.ok(!printed.includes(s), 'a secret reached the server output');
      assert.ok(!printed.includes('meera'), 'no login name in the server output either');
      assert.deepEqual(
        await filesContaining(tmp, [PW, PW2, ...secrets.filter((s) => s !== PW && s !== PW2)]),
        [],
        'no secret is stored anywhere on disk',
      );
      assert.match(printed, /Password sign-in enabled/);
    } finally {
      await api.stop();
    }
  });
});

test('coexists with Google sign-in: both methods work in one process, share one session store, and do not affect each other', async () => {
  await withTempDir('xo-pwint-both-', async (tmp) => {
    const shared = { XO_API_SESSIONS_DIR: join(tmp, 'sessions'), XO_API_OIDC_BINDINGS_DIR: join(tmp, 'bindings') };
    const env = {
      API_KEYS_DIR: join(tmp, 'keys'),
      WORKSPACES_DIR: join(tmp, 'ws'),
      WORKSPACE_DATA_DIR: join(tmp, 'wsd'),
      ...shared,
      XO_API_PASSWORD_SESSIONS_DIR: shared.XO_API_SESSIONS_DIR,
      XO_API_PASSWORD_BINDINGS_DIR: shared.XO_API_OIDC_BINDINGS_DIR,
      XO_API_ACCOUNTS_DIR: join(tmp, 'accounts'),
      ...FAST,
    };
    const idp = await TestIdp.start();
    const apiEnv = { ...env, XO_API_PASSWORD_AUTH: '1', XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_ISSUER: idp.issuer };
    const api = await startApi(apiEnv);
    try {
      // Google: bind and sign in exactly as before.
      await run(
        process.execPath,
        [
          '--import',
          'tsx',
          join('scripts', 'manage-oidc-bindings.ts'),
          'bind',
          '--issuer',
          idp.issuer,
          '--subject',
          'g-alice',
          '--identity',
          'alice',
          '--kind',
          'human',
        ],
        { cwd: APP_DIR, env: { ...process.env, ...env } },
      );
      const ch = JSON.parse((await call(api, 'POST', '/auth/login-challenge', undefined, {})).text) as {
        challengeId: string;
        nonce: string;
      };
      const idToken = await idp.sign({ sub: 'g-alice', aud: CLIENT_ID, claims: { nonce: ch.nonce } });
      const google = session(await call(api, 'POST', '/auth/session', undefined, { challengeId: ch.challengeId, idToken }));
      assert.equal((await call(api, 'GET', '/workspaces', google.accessCredential)).status, 200);

      // Password: operator-created, bound through the SAME binding store.
      const code = setupCode((await cli(['create', '--login', 'meera', '--identity', 'meera-id'], apiEnv)).out);
      assert.equal((await call(api, 'POST', '/auth/password/setup', undefined, { token: code, newPassword: PW })).status, 200);
      const pw = session(await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'meera', password: PW }));
      assert.equal((await call(api, 'GET', '/workspaces', pw.accessCredential)).status, 200);

      // Refresh and logout are the one shared pair of endpoints, and they honour the password gate.
      const pw2 = session(await call(api, 'POST', '/auth/refresh', undefined, { refreshCredential: pw.refreshCredential }));
      assert.equal((await call(api, 'GET', '/workspaces', pw2.accessCredential)).status, 200);
      const g2 = session(await call(api, 'POST', '/auth/refresh', undefined, { refreshCredential: google.refreshCredential }));
      assert.equal((await call(api, 'GET', '/workspaces', g2.accessCredential)).status, 200);

      // A password change ends the other password sessions — through the GOOGLE-configured refresh path too — and touches no Google session.
      const other = session(await call(api, 'POST', '/auth/password/login', undefined, { loginName: 'meera', password: PW }));
      assert.equal(
        (await call(api, 'POST', '/auth/password/change', pw2.accessCredential, { currentPassword: PW, newPassword: PW2 })).status,
        200,
      );
      assert.equal(
        (await call(api, 'POST', '/auth/refresh', undefined, { refreshCredential: other.refreshCredential })).status,
        401,
        'refresh of a stale password session is refused',
      );
      assert.equal((await call(api, 'GET', '/workspaces', g2.accessCredential)).status, 200, 'the Google session is unaffected');

      // Disabling the password account does not touch Google sign-in, and vice versa.
      await cli(['disable', '--login', 'meera'], apiEnv);
      assert.equal((await call(api, 'GET', '/workspaces', g2.accessCredential)).status, 200);
      assert.equal((await call(api, 'POST', '/auth/logout', g2.accessCredential, {})).status, 204);
    } finally {
      await api.stop();
      await idp.stop();
    }
  });
});
