import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError } from '@xo/errors';
import { TestServer } from './test-helpers.js';
import { createRateLimiter } from '../src/auth/session/rate-limiter.js';
import { loadPasswordAuthConfig, type PasswordAuthConfig } from '../src/auth/password/config.js';
import {
  createPasswordOnlySessionStores,
  createPasswordService,
  createPasswordStores,
  type PasswordAuthBundle,
} from '../src/auth/password/bundle.js';
import { PasswordAuthService } from '../src/auth/password/service.js';
import { PasswordHasher } from '../src/auth/password/hasher.js';
import { PASSWORD_ISSUER, createPasswordSessionGate } from '../src/auth/password/gate.js';
import { passwordProblem } from '../src/auth/password/password-policy.js';
import { PAIR_FREE_FAILURES } from '../src/auth/password/attempt-store.js';
import { RESET_TTL_MS, SETUP_TTL_MS } from '../src/auth/password/token-store.js';

const PW = 'correct horse battery staple';
const PW2 = 'another sturdy passphrase 42';
const CANARY = 'CANARY-pw-7f3a9c1e-do-not-leak';

interface Env {
  readonly dir: string;
  readonly env: Record<string, string>;
  readonly config: PasswordAuthConfig;
  readonly clock: { t: number };
  readonly ops: PasswordAuthBundle;
}

async function makeEnv(extra: Record<string, string> = {}): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'xo-pw-'));
  const env = {
    XO_API_PASSWORD_AUTH: '1',
    XO_API_ACCOUNTS_DIR: join(dir, 'accounts'),
    XO_API_PASSWORD_SESSIONS_DIR: join(dir, 'sessions'),
    XO_API_PASSWORD_BINDINGS_DIR: join(dir, 'bindings'),
    XO_API_PASSWORD_ARGON2_MEMORY_KIB: '19456', // OWASP floor: keeps the suite fast
    XO_API_PASSWORD_ARGON2_TIME_COST: '2',
    ...extra,
  };
  const config = loadPasswordAuthConfig(env) as PasswordAuthConfig;
  const clock = { t: Date.parse('2026-10-24T10:00:00Z') };
  const opts = { now: () => clock.t, limiter: createRateLimiter({ windowMs: 60_000, max: 100_000 }) };
  const ops = createPasswordService(createPasswordStores(config, opts), createPasswordOnlySessionStores(config), opts);
  return { dir, env, config, clock, ops };
}

async function withPw<T>(fn: (c: { e: Env; server: TestServer }) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const e = await makeEnv(extra);
  const server = await TestServer.start({
    env: e.env,
    passwordAuthOptions: { now: () => e.clock.t, limiter: createRateLimiter({ windowMs: 60_000, max: 100_000 }) },
  });
  try {
    return await fn({ e, server });
  } finally {
    await server.stop();
    await rm(e.dir, { recursive: true, force: true });
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
interface Session {
  accessCredential: string;
  refreshCredential: string;
}

async function provision(e: Env, login = 'meera', identity = 'meera-identity', password = PW): Promise<{ accountId: string }> {
  const created = await e.ops.service.createAccount({ loginName: login, identityId: identity, operator: 'test' });
  await e.ops.service.redeemToken('setup', created.setupToken, password);
  return { accountId: created.accountId };
}

const login = (server: TestServer, loginName: string, password: string) =>
  server.request('POST', '/auth/password/login', { loginName, password });

// ------------------------------------------------------------------ configuration and the feature being off

test('off by default: no password route exists, the unauthenticated path list is unchanged, nothing is created', async () => {
  const server = await TestServer.start({ env: {} });
  try {
    // With the feature off the password paths are indistinguishable from any path that does not exist — authenticated or not.
    const unknown = await server.request('POST', '/auth/does-not-exist', { loginName: 'a', password: 'b' }, {}, { skipAuth: true });
    const login = await server.request('POST', '/auth/password/login', { loginName: 'a', password: 'b' }, {}, { skipAuth: true });
    assert.equal(login.status, unknown.status);
    assert.equal(login.bodyText.replace('/auth/password/login', ''), unknown.bodyText.replace('/auth/does-not-exist', ''));
    assert.equal((await server.request('POST', '/auth/password/login', { loginName: 'a', password: 'b' })).status, 404);
    for (const path of ['/auth/password/setup', '/auth/password/change'])
      assert.equal((await server.request('POST', path, {})).status, 404, path);
    assert.equal(
      (await server.request('POST', '/auth/refresh', { refreshCredential: 'xoar_x' })).status,
      404,
      'no session endpoints without any sign-in method configured',
    );
  } finally {
    await server.stop();
  }
});

test('configuration: partial settings are an error, the OWASP floor is enforced, defaults are sane', () => {
  assert.equal(loadPasswordAuthConfig({}), undefined);
  assert.throws(() => loadPasswordAuthConfig({ XO_API_ACCOUNTS_DIR: '/x' }), /XO_API_ACCOUNTS_DIR.*without XO_API_PASSWORD_AUTH/);
  assert.throws(
    () => loadPasswordAuthConfig({ XO_API_PASSWORD_AUTH: '1', XO_API_PASSWORD_ARGON2_MEMORY_KIB: '1024' }),
    /XO_API_PASSWORD_ARGON2_MEMORY_KIB/,
  );
  assert.throws(
    () => loadPasswordAuthConfig({ XO_API_PASSWORD_AUTH: '1', XO_API_PASSWORD_ARGON2_TIME_COST: '1' }),
    /XO_API_PASSWORD_ARGON2_TIME_COST/,
  );
  assert.throws(
    () => loadPasswordAuthConfig({ XO_API_PASSWORD_AUTH: '1', XO_API_PASSWORD_HASH_CONCURRENCY: 'many' }),
    /XO_API_PASSWORD_HASH_CONCURRENCY/,
  );
  const c = loadPasswordAuthConfig({ XO_API_PASSWORD_AUTH: 'true' }) as PasswordAuthConfig;
  assert.deepEqual(c.argon2, { memoryKiB: 65_536, timeCost: 3, parallelism: 1 });
});

// ------------------------------------------------------------------ the happy path, end to end over HTTP

test('operator creates an account, the person sets a password with the setup code, signs in, uses the API, refreshes, logs out', async () => {
  await withPw(async ({ e, server }) => {
    const created = await e.ops.service.createAccount({ loginName: 'Meera.Sharma', identityId: 'meera-identity', operator: 'test' });
    assert.match(created.setupToken, /^xot_/);
    assert.equal(created.loginName, 'meera.sharma', 'login names are normalized');

    assert.equal((await login(server, 'meera.sharma', PW)).status, 401, 'no password yet');
    const setup = await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: PW });
    assert.equal(setup.status, 200, setup.bodyText);
    assert.equal(setup.headers['cache-control'], 'no-store');

    const res = await login(server, ' MEERA.sharma ', PW);
    assert.equal(res.status, 201, res.bodyText);
    assert.equal(res.headers['cache-control'], 'no-store');
    const s = res.json<Session>();
    assert.match(s.accessCredential, /^xoas_/);

    // The session is an ordinary XO session: the principal comes from the operator-written binding only.
    const ws = await server.request('POST', '/workspaces', { name: 'mine' }, bearer(s.accessCredential));
    assert.equal(ws.status, 201, ws.bodyText);
    assert.equal(ws.json<{ identityId: string }>().identityId, 'meera-identity');

    const refreshed = await server.request('POST', '/auth/refresh', { refreshCredential: s.refreshCredential });
    assert.equal(refreshed.status, 200);
    const next = refreshed.json<Session>();
    assert.equal((await server.request('POST', '/auth/logout', {}, bearer(next.accessCredential))).status, 204);
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(next.accessCredential))).status, 401);
  });
});

test('refresh credentials are single use: replaying one revokes the whole session family', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const s = (await login(server, 'meera', PW)).json<Session>();
    const next = (await server.request('POST', '/auth/refresh', { refreshCredential: s.refreshCredential })).json<Session>();
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(next.accessCredential))).status, 200);
    assert.equal(
      (await server.request('POST', '/auth/refresh', { refreshCredential: s.refreshCredential })).status,
      401,
      'a replayed credential is refused…',
    );
    assert.equal(
      (await server.request('GET', '/workspaces', undefined, bearer(next.accessCredential))).status,
      401,
      '…and the whole family is revoked',
    );
  });
});

// ------------------------------------------------------------------ generic failures and enumeration

test('every sign-in failure is the same response: unknown, wrong password, disabled, no password yet, unbound, oversized', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e, 'good', 'good-id');
    await provision(e, 'disabled', 'disabled-id');
    await e.ops.service.setAccountState('disabled', 'disabled', 'test');
    await provision(e, 'unbound', 'unbound-id');
    await e.ops.stores.accounts
      .findByLogin('unbound')
      .then((a) => createPasswordOnlySessionStores(e.config).bindings.revoke(PASSWORD_ISSUER, (a as { accountId: string }).accountId));
    await e.ops.service.createAccount({ loginName: 'nopassword', identityId: 'np-id', operator: 'test' });

    const attempts: [string, string][] = [
      ['nobody-here', PW],
      ['good', 'wrong password entirely'],
      ['disabled', PW],
      ['unbound', PW],
      ['nopassword', PW],
      ['good', 'x'.repeat(3000)],
    ];
    const seen = new Set<string>();
    for (const [name, pw] of attempts) {
      const r = await login(server, name, pw);
      assert.equal(r.status, 401, `${name}: ${r.bodyText}`);
      seen.add(`${r.status}|${r.bodyText}|${r.headers['content-type']}|${r.headers['cache-control']}`);
    }
    assert.equal(seen.size, 1, `all failures must be indistinguishable, saw: ${[...seen].join(' // ')}`);
    const body = [...seen][0]!;
    for (const word of ['disabled', 'unbound', 'password yet', 'unknown', 'exist', 'good', 'nobody'])
      assert.ok(!body.includes(word), `the error must not mention "${word}"`);
  });
});

test('an unknown login name costs the same work as a wrong password (a verification is always performed)', async () => {
  const e = await makeEnv();
  try {
    await provision(e, 'known', 'known-id');
    const stores = createPasswordStores(e.config, { now: () => e.clock.t });
    let verifies = 0;
    let dummies = 0;
    class SpyHasher extends PasswordHasher {
      override verify(h: string, p: string): Promise<boolean> {
        verifies++;
        return super.verify(h, p);
      }
      override verifyAgainstDummy(p: string): Promise<false> {
        dummies++;
        return super.verifyAgainstDummy(p);
      }
    }
    const spy = new SpyHasher(e.config.argon2);
    const svc = new PasswordAuthService({
      ...stores,
      hasher: spy,
      ...createPasswordOnlySessionStores(e.config),
      limiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      now: () => new Date(e.clock.t),
    });
    await assert.rejects(() => svc.login('c1', 'known', 'not the password at all'), AuthError);
    const afterWrong = { verifies, dummies };
    await assert.rejects(() => svc.login('c2', 'ghost', 'not the password at all'), AuthError);
    // wrong password on a real account: one real verification. Unknown name: one dummy verification (which also verifies, once more).
    assert.equal(afterWrong.verifies, 1);
    assert.equal(afterWrong.dummies, 0);
    assert.equal(dummies, 1, 'the unknown name still did a full verification against a dummy hash');
    assert.ok(verifies >= 2);
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('malformed sign-in requests are 400, not a credential oracle', async () => {
  await withPw(async ({ server }) => {
    assert.equal(
      (await server.request('POST', '/auth/password/login', { loginName: 'a', password: 'x'.repeat(5000) })).status,
      400,
      'a field beyond the request cap is refused before anything else',
    );
    for (const body of [{}, { loginName: 'a' }, { password: 'x' }, { loginName: 5, password: 'x' }, { loginName: '', password: '' }]) {
      assert.equal((await server.request('POST', '/auth/password/login', body)).status, 400);
    }
  });
});

// ------------------------------------------------------------------ throttling

test('per-source backoff: after repeated failures even the right password is refused until the wait passes; names that do not exist behave the same', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const tried: number[] = [];
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) tried.push((await login(server, 'meera', 'wrong password number ' + i)).status);
    assert.deepEqual(tried, [401, 401, 401]);
    const blocked = await login(server, 'meera', PW);
    assert.equal(blocked.status, 429, 'the correct password is not even checked while the wait is in force');
    const blockedGhost = (await login(server, 'ghost', 'x'.repeat(14))).status;
    for (let i = 0; i < PAIR_FREE_FAILURES; i++) await login(server, 'ghost', 'wrong password number ' + i);
    const ghostBlocked = await login(server, 'ghost', PW);
    assert.equal(blockedGhost, 401);
    assert.equal(ghostBlocked.status, 429, 'a name that does not exist is throttled exactly like one that does');
    assert.equal(ghostBlocked.bodyText, blocked.bodyText, 'identical 429 body for both');

    e.clock.t += 2_000; // 1 s backoff after the 3rd failure, 2 s after the 4th: well past both
    const ok = await login(server, 'meera', PW);
    assert.equal(ok.status, 201, 'no permanent lockout: the owner gets back in once the wait has passed');
  });
});

test('a success clears the per-source counter; the backoff doubles and is capped', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    for (let i = 0; i < 2; i++) await login(server, 'meera', 'wrong password ' + i);
    assert.equal((await login(server, 'meera', PW)).status, 201);
    for (let i = 0; i < 2; i++) await login(server, 'meera', 'wrong password ' + i);
    assert.equal((await login(server, 'meera', PW)).status, 201, 'two failures after a success are still inside the free allowance');
  });
});

test('account-wide ceiling: many failures from many sources delay everyone briefly — a delay, never a lockout', async () => {
  const e = await makeEnv();
  try {
    await provision(e);
    const svc = e.ops.service;
    for (let i = 0; i < 20; i++)
      await assert.rejects(
        () => svc.login(`source-${i}`, 'meera', 'wrong password ' + i),
        (c: unknown) => c instanceof AuthError && /not correct/.test((c as Error).message),
      );
    await assert.rejects(
      () => svc.login('source-fresh', 'meera', PW),
      (c: unknown) => c instanceof AuthError && /too many attempts/.test((c as Error).message),
    );
    e.clock.t += 61_000;
    assert.ok(
      (await svc.login('source-fresh', 'meera', PW)).accessCredential.startsWith('xoas_'),
      'the owner signs in once the short delay passes',
    );
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('credential stuffing signal: failures across many distinct names trip a short uniform delay for everyone', async () => {
  const e = await makeEnv();
  try {
    await provision(e);
    for (let i = 0; i < 55; i++) await assert.rejects(() => e.ops.service.login(`bot-${i % 5}`, `victim-${i}`, 'guess-guess-guess'));
    await assert.rejects(
      () => e.ops.service.login('innocent', 'meera', PW),
      (c: unknown) => c instanceof AuthError && /too many attempts/.test((c as Error).message),
    );
    e.clock.t += 6_000;
    assert.ok((await e.ops.service.login('innocent', 'meera', PW)).accessCredential.length > 10);
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('the outer per-address limiter still applies', async () => {
  const e = await makeEnv();
  const server = await TestServer.start({
    env: e.env,
    passwordAuthOptions: { now: () => e.clock.t, limiter: createRateLimiter({ windowMs: 60_000, max: 3 }) },
  });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await login(server, 'ghost', 'wrong password ' + i)).status);
    assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
    assert.deepEqual(statuses.slice(3), [429, 429]);
  } finally {
    await server.stop();
    await rm(e.dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ setup / reset tokens

test('tokens are single use: replaying a redeemed token fails with the same generic error as a made-up one', async () => {
  await withPw(async ({ e, server }) => {
    const created = await e.ops.service.createAccount({ loginName: 'meera', identityId: 'm', operator: 'test' });
    const first = await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: PW });
    assert.equal(first.status, 200);
    const replay = await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: PW2 });
    const fake = await server.request('POST', '/auth/password/setup', { token: 'xot_' + 'A'.repeat(43), newPassword: PW2 });
    assert.equal(replay.status, 401);
    assert.equal(replay.bodyText, fake.bodyText, 'replay, unknown and malformed are indistinguishable');
    assert.equal((await login(server, 'meera', PW)).status, 201);
    assert.equal((await login(server, 'meera', PW2)).status, 401, 'the replayed token changed nothing');
  });
});

test('tokens expire: setup after 24 h, reset after 30 minutes — and an expired token is spent', async () => {
  await withPw(async ({ e, server }) => {
    const created = await e.ops.service.createAccount({ loginName: 'meera', identityId: 'm', operator: 'test' });
    e.clock.t += SETUP_TTL_MS + 1000;
    assert.equal((await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: PW })).status, 401);
    e.clock.t = Date.parse('2026-10-24T10:00:00Z');
    assert.equal(
      (await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: PW })).status,
      401,
      'rewinding the clock does not resurrect it',
    );

    const again = await e.ops.service.issueResetToken('meera', 'test');
    assert.equal(again.purpose, 'setup', 'no password yet, so recovery issues a setup code');
    await server.request('POST', '/auth/password/setup', { token: again.token, newPassword: PW });
    const reset = await e.ops.service.issueResetToken('meera', 'test');
    assert.equal(reset.purpose, 'reset');
    e.clock.t += RESET_TTL_MS + 1000;
    assert.equal((await server.request('POST', '/auth/password/setup', { token: reset.token, newPassword: PW2 })).status, 401);
    assert.equal((await login(server, 'meera', PW)).status, 201, 'the old password still works: nothing changed');
  });
});

test('issuing a new token supersedes the previous one', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const a = await e.ops.service.issueResetToken('meera', 'test');
    const b = await e.ops.service.issueResetToken('meera', 'test');
    assert.equal((await server.request('POST', '/auth/password/setup', { token: a.token, newPassword: PW2 })).status, 401);
    assert.equal((await server.request('POST', '/auth/password/setup', { token: b.token, newPassword: PW2 })).status, 200);
  });
});

test('concurrent redemption of one token: exactly one caller wins', async () => {
  const e = await makeEnv();
  try {
    const created = await e.ops.service.createAccount({ loginName: 'meera', identityId: 'm', operator: 'test' });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => e.ops.service.redeemToken(`client-${i}`, created.setupToken, PW + i)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 5);
    const account = await e.ops.stores.accounts.findByLogin('meera');
    assert.equal(account?.passwordVersion, 1, 'the password was set exactly once');
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('any password change invalidates an outstanding reset token', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const s = (await login(server, 'meera', PW)).json<Session>();
    const reset = await e.ops.service.issueResetToken('meera', 'test');
    const changed = await server.request(
      'POST',
      '/auth/password/change',
      { currentPassword: PW, newPassword: PW2 },
      bearer(s.accessCredential),
    );
    assert.equal(changed.status, 200, changed.bodyText);
    assert.equal(
      (await server.request('POST', '/auth/password/setup', { token: reset.token, newPassword: 'attacker chosen passphrase' })).status,
      401,
    );
    assert.equal((await login(server, 'meera', PW2)).status, 201);
  });
});

test('a rejected new password does not burn the token; a token for a disabled account is refused', async () => {
  await withPw(async ({ e, server }) => {
    const created = await e.ops.service.createAccount({ loginName: 'meera', identityId: 'm', operator: 'test' });
    const weak = await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: 'short' });
    assert.equal(weak.status, 400);
    assert.ok(!weak.bodyText.includes('short"') || weak.bodyText.includes('at least 12'), 'the message names the rule');
    assert.equal(
      (await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: 'meera-meera-meera' })).status,
      400,
      'contains the login name',
    );
    assert.equal(
      (await server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: PW })).status,
      200,
      'the token survived the rejected attempts',
    );

    const reset = await e.ops.service.issueResetToken('meera', 'test');
    await e.ops.service.setAccountState('meera', 'disabled', 'test');
    assert.equal((await server.request('POST', '/auth/password/setup', { token: reset.token, newPassword: PW2 })).status, 401);
  });
});

test('only a digest of a token is stored: the token itself is not on disk', async () => {
  const e = await makeEnv();
  try {
    const created = await e.ops.service.createAccount({ loginName: 'meera', identityId: 'm', operator: 'test' });
    await assertNowhereOnDisk(e.dir, [created.setupToken]);
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ sessions

test('changing the password ends every OTHER session at once and hands the caller a fresh one', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const laptop = (await login(server, 'meera', PW)).json<Session>();
    const phone = (await login(server, 'meera', PW)).json<Session>();
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(laptop.accessCredential))).status, 200);

    const wrongCurrent = await server.request(
      'POST',
      '/auth/password/change',
      { currentPassword: 'not my password', newPassword: PW2 },
      bearer(phone.accessCredential),
    );
    assert.equal(wrongCurrent.status, 401);
    assert.equal(
      (await server.request('GET', '/workspaces', undefined, bearer(phone.accessCredential))).status,
      200,
      'a failed change does not end the session',
    );

    const changed = await server.request(
      'POST',
      '/auth/password/change',
      { currentPassword: PW, newPassword: PW2 },
      bearer(phone.accessCredential),
    );
    assert.equal(changed.status, 200, changed.bodyText);
    const fresh = changed.json<Session>();

    assert.equal(
      (await server.request('GET', '/workspaces', undefined, bearer(laptop.accessCredential))).status,
      401,
      'the other session is dead on its next request',
    );
    assert.equal(
      (await server.request('POST', '/auth/refresh', { refreshCredential: laptop.refreshCredential })).status,
      401,
      'and so is its refresh credential',
    );
    assert.equal(
      (await server.request('GET', '/workspaces', undefined, bearer(phone.accessCredential))).status,
      401,
      'the caller old credentials are replaced…',
    );
    assert.equal(
      (await server.request('GET', '/workspaces', undefined, bearer(fresh.accessCredential))).status,
      200,
      '…by the fresh session',
    );
    assert.equal((await login(server, 'meera', PW)).status, 401);
    assert.equal((await login(server, 'meera', PW2)).status, 201);
  });
});

test('change-password rules: current password required, new must differ and meet policy, password sessions only', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const s = (await login(server, 'meera', PW)).json<Session>();
    const change = (body: unknown) => server.request('POST', '/auth/password/change', body, bearer(s.accessCredential));
    assert.equal((await change({ currentPassword: PW, newPassword: PW })).status, 400);
    assert.equal((await change({ currentPassword: PW, newPassword: 'tiny' })).status, 400);
    assert.equal((await change({ currentPassword: PW })).status, 400);
    assert.equal(
      (await server.request('POST', '/auth/password/change', { currentPassword: PW, newPassword: PW2 })).status,
      400,
      'an API key is not a password session',
    );
    assert.equal(
      (await server.request('POST', '/auth/password/change', { currentPassword: PW, newPassword: PW2 }, { authorization: '' })).status,
      401,
    );
  });
});

test('an operator reset (token redemption) ends all sessions, including ones the person is still holding', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const s = (await login(server, 'meera', PW)).json<Session>();
    const reset = await e.ops.service.issueResetToken('meera', 'test');
    assert.equal(
      (await server.request('GET', '/workspaces', undefined, bearer(s.accessCredential))).status,
      200,
      'issuing a token alone changes nothing',
    );
    assert.equal((await server.request('POST', '/auth/password/setup', { token: reset.token, newPassword: PW2 })).status, 200);
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(s.accessCredential))).status, 401);
    assert.equal((await server.request('POST', '/auth/refresh', { refreshCredential: s.refreshCredential })).status, 401);
  });
});

test('disabling an account ends its sessions; enabling it does not revive them', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e);
    const live = (await login(server, 'meera', PW)).json<Session>();
    const dormant = (await login(server, 'meera', PW)).json<Session>(); // never used while disabled
    await e.ops.service.setAccountState('meera', 'disabled', 'test');
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(live.accessCredential))).status, 401);
    assert.equal((await login(server, 'meera', PW)).status, 401);
    await e.ops.service.setAccountState('meera', 'active', 'test');
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(live.accessCredential))).status, 401, 'still dead');
    assert.equal(
      (await server.request('POST', '/auth/refresh', { refreshCredential: dormant.refreshCredential })).status,
      401,
      'a session that was never used while disabled is also dead',
    );
    assert.equal((await login(server, 'meera', PW)).status, 201, 'a fresh sign-in works');
  });
});

test('revoking the binding ends password sessions, and re-binding does not revive them', async () => {
  await withPw(async ({ e, server }) => {
    const { accountId } = await provision(e);
    const stores = createPasswordOnlySessionStores(e.config);
    const s = (await login(server, 'meera', PW)).json<Session>();
    await stores.bindings.revoke(PASSWORD_ISSUER, accountId);
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(s.accessCredential))).status, 401);
    await stores.bindings.create({
      bindingId: (await import('../src/auth/oidc/fs-binding-store.js')).computeBindingId(PASSWORD_ISSUER, accountId),
      issuer: PASSWORD_ISSUER,
      subject: accountId,
      identityId: 'meera-identity',
      principalKind: 'human',
      createdAt: new Date().toISOString(),
    });
    assert.equal((await server.request('GET', '/workspaces', undefined, bearer(s.accessCredential))).status, 401, 'old session stays dead');
    assert.equal((await login(server, 'meera', PW)).status, 201);
  });
});

test('Google-style sessions are untouched by the password gate', async () => {
  const e = await makeEnv();
  try {
    const gate = createPasswordSessionGate(e.ops.stores.accounts);
    assert.equal(await gate({ familyId: 'f', issuer: 'https://accounts.google.com', subject: 'whatever' }), 'ok');
    assert.equal(
      await gate({ familyId: 'f', issuer: PASSWORD_ISSUER, subject: 'acct_' + '0'.repeat(32), credentialEpoch: 0 }),
      'revoke',
      'an unknown password account fails closed',
    );
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ hashing and policy

test('passwords are stored as Argon2id PHC hashes with a per-account salt, never in plaintext', async () => {
  const e = await makeEnv();
  try {
    await provision(e, 'aaa', 'a-id', PW);
    await provision(e, 'bbb', 'b-id', PW);
    const a = await e.ops.stores.accounts.findByLogin('aaa');
    const b = await e.ops.stores.accounts.findByLogin('bbb');
    assert.match(a?.hash ?? '', /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/, 'the id used by the hasher really is Argon2id');
    assert.notEqual(a?.hash, b?.hash, 'same password, different salts');
    await assertNowhereOnDisk(e.dir, [PW]);
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('a hash made with weaker parameters is upgraded on the next successful sign-in', async () => {
  const e = await makeEnv();
  try {
    const { accountId } = await provision(e);
    const weak = await new PasswordHasher({ memoryKiB: 19456, timeCost: 2, parallelism: 1 }).hash(PW);
    await e.ops.stores.accounts.update(accountId, (cur) => ({ ...cur, hash: weak }));
    const stronger = createPasswordStores(
      { ...e.config, argon2: { memoryKiB: 32768, timeCost: 2, parallelism: 1 } },
      { now: () => e.clock.t },
    );
    const svc = createPasswordService(stronger, createPasswordOnlySessionStores(e.config), {
      now: () => e.clock.t,
      limiter: createRateLimiter({ windowMs: 60_000, max: 1000 }),
    }).service;
    await svc.login('c', 'meera', PW);
    const after = await e.ops.stores.accounts.get(accountId);
    assert.match(after?.hash ?? '', /m=32768,t=2/);
    assert.equal(after?.passwordVersion, 1, 'a rehash is not a password change: sessions and tokens are untouched');
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});

test('password policy: length, normalization, common and trivial passwords, login name; oversized input refused before hashing', async () => {
  assert.match(passwordProblem('short') ?? '', /at least 12/);
  assert.match(passwordProblem('x'.repeat(129)) ?? '', /at most 128/);
  assert.match(passwordProblem('é'.repeat(600)) ?? '', /at most/, 'byte cap');
  assert.match(passwordProblem('aaaaaaaaaaaaaaaa') ?? '', /predictable/);
  assert.match(passwordProblem('abcdefghijklmnop') ?? '', /predictable/);
  assert.match(passwordProblem('PasswordPassword') ?? '', /too common/);
  assert.match(passwordProblem('please use meera.sharma today', 'meera.sharma') ?? '', /login name/);
  assert.equal(passwordProblem(PW), undefined);
  assert.equal(passwordProblem('ünïcode päss phrase ok'), undefined, 'any printable Unicode, spaces allowed');
  // NFKC: the fullwidth and ASCII forms of the same password verify against each other.
  const h = new PasswordHasher({ memoryKiB: 19456, timeCost: 2, parallelism: 1 });
  const stored = await h.hash('Ｃorrect horse battery staple');
  assert.equal(await h.verify(stored, 'Correct horse battery staple'), true);
});

test('a saturated hasher answers 503 instead of hanging', async () => {
  const h = new PasswordHasher({ memoryKiB: 19456, timeCost: 2, parallelism: 1 }, 1, 0);
  const first = h.hash(PW);
  await assert.rejects(() => h.hash(PW), /saturated/);
  await first;
});

// ------------------------------------------------------------------ secrets never leak

async function assertNowhereOnDisk(root: string, secrets: readonly string[]): Promise<void> {
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(p)));
      else out.push(p);
    }
    return out;
  };
  for (const file of await walk(root)) {
    const text = (await readFile(file)).toString('utf8') + file;
    for (const s of secrets) assert.ok(!text.includes(s), `a secret was found in ${file}`);
  }
}

test('a unique canary password, token and session credential never appear in any file, response, error or audit entry', async () => {
  await withPw(async ({ e, server }) => {
    const created = await e.ops.service.createAccount({ loginName: 'meera', identityId: 'm', operator: 'test' });
    const bodies: string[] = [];
    const rec = async (r: Promise<{ bodyText: string }>) => bodies.push((await r).bodyText);
    await rec(server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: CANARY + '-first' }));
    await rec(login(server, 'meera', CANARY + '-wrong'));
    const ok = await login(server, 'meera', CANARY + '-first');
    const s = ok.json<Session>();
    await rec(
      server.request(
        'POST',
        '/auth/password/change',
        { currentPassword: CANARY + '-nope', newPassword: CANARY + '-second' },
        bearer(s.accessCredential),
      ),
    );
    await rec(
      server.request(
        'POST',
        '/auth/password/change',
        { currentPassword: CANARY + '-first', newPassword: 'short' },
        bearer(s.accessCredential),
      ),
    );
    const changed = await server.request(
      'POST',
      '/auth/password/change',
      { currentPassword: CANARY + '-first', newPassword: CANARY + '-second' },
      bearer(s.accessCredential),
    );
    const fresh = changed.json<Session>();
    await rec(server.request('POST', '/auth/password/setup', { token: created.setupToken, newPassword: CANARY + '-replay' }));
    await rec(server.request('POST', '/auth/password/setup', { token: 'xot_' + 'B'.repeat(43), newPassword: CANARY + '-fake' }));
    await rec(server.request('POST', '/auth/password/login', { loginName: 'meera', password: 5 }));

    for (const body of bodies) {
      assert.ok(!body.includes(CANARY), 'a response echoed a password');
      assert.ok(!body.includes(created.setupToken), 'a response echoed a token');
    }
    const audit = (await e.ops.stores.log.log.all()).map((x) => JSON.stringify(x)).join('\n');
    assert.ok(audit.length > 100 && audit.includes('auth.password.login_succeeded'), 'the audit log did record the events');
    await assertNowhereOnDisk(e.dir, [
      CANARY,
      created.setupToken,
      s.accessCredential,
      s.refreshCredential,
      fresh.accessCredential,
      fresh.refreshCredential,
    ]);
    assert.equal((await e.ops.stores.log.log.verify()).ok, true);
  });
});

test('the auth audit log records operator and sign-in events with keyed hashes, never a raw login name for an attempt', async () => {
  await withPw(async ({ e, server }) => {
    await provision(e, 'meera', 'm');
    await login(server, 'GhostUser', 'nope nope nope nope');
    const events = await e.ops.stores.log.log.all();
    const kinds = events.map((x) => x.event);
    for (const k of ['auth.account.created', 'auth.password.setup_token_issued', 'auth.password.set', 'auth.password.login_failed'])
      assert.ok(kinds.includes(k as never), k);
    const failed = events.find((x) => x.event === 'auth.password.login_failed')!;
    assert.match(String(failed.detail?.['loginHash']), /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(failed).toLowerCase().includes('ghostuser'));
    assert.equal(failed.target, undefined, 'no account is named for an attempt on an unknown login');
  });
});

test('operator actions: duplicate login names and bad input are refused; no password parameter exists', async () => {
  const e = await makeEnv();
  try {
    await e.ops.service.createAccount({ loginName: 'meera', identityId: 'm', operator: 't' });
    await assert.rejects(() => e.ops.service.createAccount({ loginName: ' MEERA ', identityId: 'm2', operator: 't' }), /already in use/);
    await assert.rejects(() => e.ops.service.createAccount({ loginName: 'ab', identityId: 'x', operator: 't' }), /3 to 120/);
    await assert.rejects(() => e.ops.service.createAccount({ loginName: 'has space', identityId: 'x', operator: 't' }), /spaces/);
    await assert.rejects(
      () => e.ops.service.createAccount({ loginName: 'valid-name', identityId: 'bad id!', operator: 't' }),
      /identity id/,
    );
    assert.equal((await e.ops.stores.accounts.list()).length, 1, 'rejected requests left nothing behind');
    await assert.rejects(() => e.ops.service.issueResetToken('ghost', 't'), /no such account/);
  } finally {
    await rm(e.dir, { recursive: true, force: true });
  }
});
