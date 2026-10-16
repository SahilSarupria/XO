import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { generateKeyPair, SignJWT } from 'jose';
import { withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import { AUDIENCE, TestIdp } from './oidc-test-idp.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

/**
 * Reproducible HTTP-boundary integration: the BUILT API (`dist/index.js`) as a real child process,
 * configured only through its environment, in front of a local test issuer with generated keys.
 * Normal CI needs no credentials and no network. Tokens and secrets are never put in assertion
 * messages; every assertion that touches one reports a fixed description.
 */

const run = promisify(execFile);
const APP_DIR = resolve(import.meta.dirname, '..');
const ROOT = resolve(APP_DIR, '..', '..');
const ENTRY = join(APP_DIR, 'dist', 'index.js');
const SECRET_CLAIM = 'claim-value-that-must-never-appear-anywhere';

let built = false;
async function ensureBuilt(): Promise<void> {
  if (built) return;
  // Incremental and idempotent: a no-op when dist is current, so the test always runs the code under test.
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
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', XO_API_OIDC_ISSUER: '', XO_API_OIDC_AUDIENCE: '', ...env },
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
async function call(
  api: Api,
  method: string,
  path: string,
  authorization?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res> {
  const r = await fetch(`${api.base}${path}`, {
    method,
    headers: {
      ...(authorization !== undefined ? { authorization } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, text: await r.text(), headers: r.headers };
}
const bearer = (t: string): string => `Bearer ${t}`;
const errCode = (r: Res): string | undefined => (JSON.parse(r.text) as { error?: { code?: string } }).error?.code;

/** Every response must be free of credential material. Reports only which response, never its content. */
function assertNoLeak(label: string, r: Res, secrets: readonly string[]): void {
  const haystack = r.text + JSON.stringify([...r.headers.entries()]);
  for (const s of secrets) assert.ok(!haystack.includes(s), `${label}: response/headers contain credential material`);
}

test('startup: half-configured OIDC and invalid OIDC values refuse to start, naming the variable and never its value', async () => {
  await ensureBuilt();
  const attempts: Array<[Record<string, string>, RegExp]> = [
    [{ XO_API_OIDC_ISSUER: 'https://idp.example', XO_API_OIDC_AUDIENCE: '' }, /XO_API_OIDC_AUDIENCE is missing/],
    [{ XO_API_OIDC_ISSUER: '', XO_API_OIDC_AUDIENCE: 'api' }, /XO_API_OIDC_ISSUER is missing/],
    [{ XO_API_OIDC_ISSUER: 'http://idp.example', XO_API_OIDC_AUDIENCE: 'api' }, /XO_API_OIDC_ISSUER/],
    [{ XO_API_OIDC_ISSUER: 'https://user:hunter2@idp.example', XO_API_OIDC_AUDIENCE: 'api' }, /XO_API_OIDC_ISSUER/],
    [{ XO_API_OIDC_ISSUER: 'https://idp.example', XO_API_OIDC_AUDIENCE: 'api', XO_API_OIDC_CLOCK_SKEW_SECONDS: '9999' }, /CLOCK_SKEW/],
  ];
  for (const [env, expected] of attempts) {
    let failed = false;
    let output = '';
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(await freePort()), HOST: '127.0.0.1', ...env },
        timeout: 15_000,
      });
      output = stdout + stderr;
    } catch (e) {
      failed = true;
      const err = e as { code?: number; stdout?: string; stderr?: string };
      output = (err.stdout ?? '') + (err.stderr ?? '');
      assert.ok(typeof err.code === 'number' && err.code !== 0, 'non-zero exit');
    }
    assert.ok(failed, 'the process must not start');
    assert.match(output, expected);
    assert.ok(!output.includes('hunter2'), 'the supplied credential-like value is never echoed');
  }
});

test('OIDC disabled: API keys work exactly as before and a JWT gets the unchanged API-key answer', async () => {
  await withTempDir('xo-int-off-', async (tmp) => {
    const env = { API_KEYS_DIR: join(tmp, 'keys'), WORKSPACES_DIR: join(tmp, 'ws'), WORKSPACE_DATA_DIR: join(tmp, 'wsd') };
    const issued = await script('manage-keys.ts', ['issue', 'svc-1', '--kind', 'service'], env);
    const apiKey = /xoak_[A-Za-z0-9_-]+/.exec(issued)?.[0];
    assert.ok(apiKey, 'an API key was issued');
    const idp = await TestIdp.start();
    const api = await startApi(env);
    try {
      assert.equal((await call(api, 'GET', '/health')).status, 200);
      assert.equal((await call(api, 'POST', '/workspaces', bearer(apiKey), {})).status, 201);
      assert.equal((await call(api, 'GET', '/workspaces', bearer(apiKey))).status, 200);
      const jwt = await call(api, 'GET', '/workspaces', bearer(await idp.sign()));
      assert.equal(jwt.status, 401);
      assert.equal(errCode(jwt), 'XO_AUTH_KEY_INVALID');
      assert.equal(errCode(await call(api, 'GET', '/workspaces')), 'XO_AUTH_KEY_MISSING');
      assert.equal(errCode(await call(api, 'GET', '/workspaces', 'Bearer xoak_unknown')), 'XO_AUTH_KEY_INVALID');
    } finally {
      await api.stop();
      await idp.stop();
    }
  });
});

test('OIDC enabled: authentication, binding, revocation and every rejection at the real HTTP boundary', async () => {
  await withTempDir('xo-int-on-', async (tmp) => {
    const bindDir = join(tmp, 'bindings');
    const env = {
      API_KEYS_DIR: join(tmp, 'keys'),
      WORKSPACES_DIR: join(tmp, 'ws'),
      WORKSPACE_DATA_DIR: join(tmp, 'wsd'),
      XO_API_OIDC_BINDINGS_DIR: bindDir,
    };
    const idp = await TestIdp.start();
    const issued = await script('manage-keys.ts', ['issue', 'svc-1', '--kind', 'service'], env);
    const apiKey = /xoak_[A-Za-z0-9_-]+/.exec(issued)?.[0];
    assert.ok(apiKey, 'an API key was issued');
    const bind = (sub: string, id: string): Promise<string> =>
      script('manage-oidc-bindings.ts', ['bind', '--issuer', idp.issuer, '--subject', sub, '--identity', id, '--kind', 'human'], env);
    await bind('alice-sub', 'alice');
    await bind('bob-sub', 'bob');

    const api = await startApi({ ...env, XO_API_OIDC_ISSUER: idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE });
    const seen: string[] = []; // every credential-bearing string we sent, to check server output at the end
    const tok = async (o: Parameters<TestIdp['sign']>[0] = {}): Promise<string> => {
      const t = await idp.sign({ ...o, claims: { email: SECRET_CLAIM, ...(o?.claims ?? {}) } });
      seen.push(t);
      return t;
    };
    const expectFail = async (name: string, token: string, status: number, code: string): Promise<void> => {
      seen.push(token);
      const r = await call(api, 'GET', '/workspaces', bearer(token));
      assert.equal(r.status, status, `${name}: status`);
      assert.equal(errCode(r), code, `${name}: code`);
      assertNoLeak(name, r, [token, SECRET_CLAIM, idp.issuer]);
    };
    try {
      const alice = await tok({ sub: 'alice-sub' });
      const bob = await tok({ sub: 'bob-sub' });

      // 3-5: a valid token authenticates; the workspace belongs to the bound principal, not to a body field.
      const created = await call(
        api,
        'POST',
        '/workspaces',
        bearer(alice),
        { identityId: 'bob', ownerId: 'bob', principal: { kind: 'service', id: 'svc-1' }, orgId: 'evil' },
        { 'x-xo-principal': 'bob' },
      );
      assert.equal(created.status, 201, 'authorized OIDC request creates a workspace');
      assertNoLeak('create', created, [alice, SECRET_CLAIM]);
      const wsId = (JSON.parse(created.text) as WorkspaceRecord).workspaceId;
      assert.equal((await call(api, 'GET', `/workspaces/${wsId}`, bearer(alice))).status, 200, 'owner (alice) sees it');
      assert.equal(
        (await call(api, 'GET', `/workspaces/${wsId}`, bearer(bob))).status,
        404,
        'a different bound identity does not, despite the spoofed body',
      );
      assert.equal((await call(api, 'GET', `/workspaces/${wsId}`, bearer(apiKey))).status, 404, 'the API-key principal does not');

      // 6: unbound
      await expectFail('unbound', await tok({ sub: 'stranger' }), 401, 'XO_AUTH_IDENTITY_UNBOUND');

      // 8-10: claim, signature, algorithm and token-type failures
      const now = Math.floor(Date.now() / 1000);
      await expectFail('wrong issuer', await tok({ iss: 'https://evil.example' }), 401, 'XO_AUTH_TOKEN_INVALID');
      await expectFail('wrong audience', await tok({ aud: 'someone-else' }), 401, 'XO_AUTH_TOKEN_INVALID');
      await expectFail('expired', await tok({ iat: now - 7200, exp: now - 3600 }), 401, 'XO_AUTH_TOKEN_EXPIRED');
      await expectFail('not yet valid', await tok({ nbf: now + 3600, exp: now + 7200 }), 401, 'XO_AUTH_TOKEN_INVALID');
      await expectFail('issued in the future', await tok({ iat: now + 3600, exp: now + 7200 }), 401, 'XO_AUTH_TOKEN_INVALID');
      await expectFail('malformed', 'aaa.bbb.ccc', 401, 'XO_AUTH_TOKEN_INVALID');
      await expectFail('ID token (nonce)', await tok({ claims: { nonce: 'n-0S6_WzA2Mj' } }), 401, 'XO_AUTH_TOKEN_INVALID');
      await expectFail('ID token (typ)', await tok({ typ: 'id_token' }), 401, 'XO_AUTH_TOKEN_INVALID');
      const [h, p, s] = alice.split('.') as [string, string, string];
      const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'bob-sub' })).toString(
        'base64url',
      );
      await expectFail('tampered payload', `${h}.${forgedPayload}.${s}`, 401, 'XO_AUTH_TOKEN_INVALID');
      const foreign = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(idp.issuer)
        .setAudience(AUDIENCE)
        .setSubject('alice-sub')
        .setExpirationTime('5m')
        .sign((await generateKeyPair('RS256')).privateKey);
      await expectFail('incorrect signature', foreign, 401, 'XO_AUTH_TOKEN_INVALID');
      const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
      const claims = enc({ iss: idp.issuer, aud: AUDIENCE, sub: 'alice-sub', exp: now + 300 });
      await expectFail('alg none', `${enc({ alg: 'none', typ: 'JWT' })}.${claims}.`, 401, 'XO_AUTH_TOKEN_INVALID');
      await expectFail(
        'unsupported algorithm (HS256)',
        `${enc({ alg: 'HS256', kid: 'k1' })}.${claims}.${Buffer.from('x').toString('base64url')}`,
        401,
        'XO_AUTH_TOKEN_INVALID',
      );
      await expectFail(
        'unsupported algorithm (ES512)',
        `${enc({ alg: 'ES512', kid: 'k1' })}.${claims}.${Buffer.from('x').toString('base64url')}`,
        401,
        'XO_AUTH_TOKEN_INVALID',
      );

      // 11: credential shapes
      for (const [name, header, code] of [
        ['no credential', undefined, 'XO_AUTH_KEY_MISSING'],
        ['wrong scheme', `Basic ${Buffer.from('a:b').toString('base64')}`, 'XO_AUTH_KEY_MISSING'],
        ['bare token', alice, 'XO_AUTH_KEY_MISSING'],
        ['empty bearer', 'Bearer ', 'XO_AUTH_KEY_MISSING'],
        ['unknown API key', 'Bearer xoak_nonexistent', 'XO_AUTH_KEY_INVALID'],
        ['opaque token', 'Bearer opaque-token-value', 'XO_AUTH_KEY_INVALID'],
      ] as const) {
        const r = await call(api, 'GET', '/workspaces', header);
        assert.equal(r.status, 401, name);
        assert.equal(errCode(r), code, name);
      }
      assert.equal((await call(api, 'GET', '/workspaces', bearer(apiKey))).status, 200, 'API keys still authenticate with OIDC on');

      // 12: an unpublished key id is refused. (Picking up a NEWLY published key is rate-limited to once per
      // 30 s per process by design; rotation is exercised with a short cooldown in oidc-auth.test.ts.)
      await idp.addKey('k-hidden', 'RS256', false);
      await expectFail('unknown kid', await tok({ sub: 'alice-sub', kid: 'k-hidden' }), 401, 'XO_AUTH_TOKEN_INVALID');
      await idp.addKey('k-rot');
      await expectFail(
        'key published after the cache was filled is not picked up inside the cooldown',
        await tok({ sub: 'alice-sub', kid: 'k-rot' }),
        401,
        'XO_AUTH_TOKEN_INVALID',
      );

      // 7: revocation takes effect on the very next request
      const revoked = await script('manage-oidc-bindings.ts', ['revoke', '--issuer', idp.issuer, '--subject', 'alice-sub'], env);
      assert.match(revoked, /revoked/i);
      await expectFail('revoked binding', alice, 401, 'XO_AUTH_IDENTITY_UNBOUND');
      assert.equal((await call(api, 'GET', '/workspaces', bearer(bob))).status, 200, 'other bindings unaffected');

      // 14: nothing credential-shaped in the server's own output
      const log = api.output();
      for (const t of seen) assert.ok(!log.includes(t), 'a bearer token appears in the API process output');
      assert.ok(!log.includes(SECRET_CLAIM), 'a token claim appears in the API process output');
      assert.ok(!log.toLowerCase().includes('authorization'), 'an authorization header appears in the API process output');
    } finally {
      await api.stop();
      await idp.stop();
    }
  });
});

test('OIDC enabled: provider faults fail closed with 503 at the HTTP boundary and recover; a fault never authenticates anyone', async () => {
  await withTempDir('xo-int-faults-', async (tmp) => {
    const env = {
      API_KEYS_DIR: join(tmp, 'keys'),
      WORKSPACES_DIR: join(tmp, 'ws'),
      WORKSPACE_DATA_DIR: join(tmp, 'wsd'),
      XO_API_OIDC_BINDINGS_DIR: join(tmp, 'bindings'),
    };
    const idp = await TestIdp.start();
    await script(
      'manage-oidc-bindings.ts',
      ['bind', '--issuer', idp.issuer, '--subject', 'alice-sub', '--identity', 'alice', '--kind', 'human'],
      env,
    );
    const api = await startApi({ ...env, XO_API_OIDC_ISSUER: idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE });
    try {
      const alice = bearer(await idp.sign({ sub: 'alice-sub', claims: { email: SECRET_CLAIM } }));
      const faulted = async (name: string): Promise<void> => {
        const r = await call(api, 'GET', '/workspaces', alice);
        assert.equal(r.status, 503, `${name}: status`);
        assert.equal(errCode(r), 'XO_AUTH_PROVIDER_UNAVAILABLE', `${name}: code`);
        assertNoLeak(name, r, [alice, SECRET_CLAIM, idp.issuer]);
      };
      // The very first verification meets each fault: there is no cached key set to fall back on.
      idp.jwksBody = 'definitely not json';
      await faulted('malformed JWKS');
      idp.jwksBody = '{"keys":"nope"}';
      await faulted('structurally invalid JWKS');
      idp.jwksBody = undefined;
      idp.jwksStatus = 500;
      await faulted('JWKS 5xx');
      idp.jwksStatus = 200;
      idp.jwksRedirect = true;
      await faulted('JWKS redirect');
      idp.jwksRedirect = false;
      assert.equal((await call(api, 'GET', '/workspaces', alice)).status, 200, 'recovers as soon as the key set is readable');
      assert.equal(
        (await call(api, 'GET', '/workspaces', 'Bearer xoak_unknown')).status,
        401,
        'API-key handling is independent of provider health',
      );
      assert.ok(!api.output().includes(SECRET_CLAIM));
    } finally {
      await api.stop();
    }

    // Discovery failure on a fresh process (nothing cached): 503, then recovery once the short retry window passes.
    const idp2 = await TestIdp.start();
    await script(
      'manage-oidc-bindings.ts',
      [
        'bind',
        '--issuer',
        idp2.issuer,
        '--subject',
        'alice-sub',
        '--identity',
        'alice',
        '--kind',
        'human',
        '--dir',
        join(tmp, 'bindings2'),
      ],
      env,
    );
    idp2.discoveryStatus = 500;
    const api2 = await startApi({
      ...env,
      XO_API_OIDC_BINDINGS_DIR: join(tmp, 'bindings2'),
      XO_API_OIDC_ISSUER: idp2.issuer,
      XO_API_OIDC_AUDIENCE: AUDIENCE,
    });
    try {
      const token = bearer(await idp2.sign({ sub: 'alice-sub' }));
      const down = await call(api2, 'GET', '/workspaces', token);
      assert.equal(down.status, 503);
      assert.equal(errCode(down), 'XO_AUTH_PROVIDER_UNAVAILABLE');
      idp2.discoveryStatus = 200;
      await new Promise((r) => setTimeout(r, 5500)); // the verifier retries discovery at most every 5 s
      assert.equal((await call(api2, 'GET', '/workspaces', token)).status, 200, 'recovers once discovery works again');
    } finally {
      await api2.stop();
      await idp.stop();
      await idp2.stop();
    }
  });
});

test('OIDC enabled: an idempotency-keyed start cannot be replayed after its binding is revoked', async () => {
  await withTempDir('xo-int-idem-', async (tmp) => {
    const env = {
      API_KEYS_DIR: join(tmp, 'keys'),
      WORKSPACES_DIR: join(tmp, 'ws'),
      WORKSPACE_DATA_DIR: join(tmp, 'wsd'),
      XO_API_OIDC_BINDINGS_DIR: join(tmp, 'bindings'),
    };
    const idp = await TestIdp.start();
    await script(
      'manage-oidc-bindings.ts',
      ['bind', '--issuer', idp.issuer, '--subject', 'alice-sub', '--identity', 'alice', '--kind', 'human'],
      env,
    );
    const api = await startApi({ ...env, XO_API_OIDC_ISSUER: idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE });
    try {
      const alice = bearer(await idp.sign({ sub: 'alice-sub' }));
      const created = await call(api, 'POST', '/workspaces', alice, {});
      assert.equal(created.status, 201);
      const workspace = JSON.parse(created.text) as WorkspaceRecord;
      const { compilationId } = await storeFixtureCompilation(workspace, env.WORKSPACE_DATA_DIR);
      const ws = `/workspaces/${workspace.workspaceId}`;
      const workflows = JSON.parse((await call(api, 'GET', `${ws}/workflows`, alice)).text) as {
        workflows: { workflowId: string; steps: { capabilityId: string }[] }[];
      };
      const workflowId = workflows.workflows.find((w) => w.steps[0]?.capabilityId === IDS.hitlA)?.workflowId;
      assert.ok(workflowId);
      for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) {
        assert.ok((await call(api, 'POST', `${ws}/compilations/${compilationId}/capabilities/${id}/approve`, alice)).status < 300);
      }
      const start = (): Promise<Res> =>
        call(
          api,
          'POST',
          `${ws}/workflows/${workflowId}/executions`,
          alice,
          { compilationId, input: { screening_score: 90, settlement_amount: 800 } },
          { 'idempotency-key': 'int-key-0001' },
        );
      const first = await start();
      assert.equal(first.status, 201, 'first start creates the run');
      const runId = (JSON.parse(first.text) as { workflowExecutionId: string }).workflowExecutionId;
      const replay = await start();
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get('idempotent-replayed'), 'true');

      await script('manage-oidc-bindings.ts', ['revoke', '--issuer', idp.issuer, '--subject', 'alice-sub'], env);
      const after = await start();
      assert.equal(after.status, 401, 'replay with a revoked binding is refused');
      assert.equal(errCode(after), 'XO_AUTH_IDENTITY_UNBOUND');
      assert.equal(after.headers.get('idempotent-replayed'), null);
      assert.ok(!after.text.includes(runId), 'the earlier result is not disclosed');
    } finally {
      await api.stop();
      await idp.stop();
    }
  });
});
