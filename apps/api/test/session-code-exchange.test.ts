import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ErrorCode, StorageError } from '@xo/errors';
import { TestServer } from './test-helpers.js';
import { TestIdp, CapturingLogger } from './oidc-test-idp.js';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';
import { loadSessionAuthConfig } from '../src/auth/session/config.js';
import { createSessionAuth } from '../src/auth/session/bundle.js';
import { createRateLimiter } from '../src/auth/session/rate-limiter.js';

/**
 * Server-side Google code exchange. Google is a local fake that enforces what the real token endpoint enforces for this
 * flow: it requires the client secret, checks PKCE S256, redeems a code once, and matches the redirect URI; the ID tokens
 * it returns are signed by a real local test issuer so the API's verifier runs for real. None of this is the real Google.
 */

const CLIENT_ID = '1234567890-xotest.apps.googleusercontent.com';
const SECRET = 'GOCSPX-test-secret-must-never-leak';
const TOKEN_URI = 'https://google.test/token';
const REDIRECT = 'http://127.0.0.1:53124/callback';
const VERIFIER = 'v'.repeat(43);
const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

interface Grant {
  readonly nonce: string;
  readonly sub: string;
  readonly challenge: string;
  readonly redirect: string;
}

class FakeGoogleToken {
  mode: 'ok' | 'invalid_client' | 'invalid_grant' | '503' | 'network' | 'no_id_token' = 'ok';
  returnRefreshToken = false;
  requests: URLSearchParams[] = [];
  revoked: string[] = [];
  private grants = new Map<string, Grant>();
  constructor(private readonly idp: TestIdp) {}

  issue(code: string, g: Grant): void {
    this.grants.set(code, g);
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const json = (o: unknown, status = 200): Response =>
      new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/revoke') {
      this.revoked.push(body.get('token') ?? '');
      return json({});
    }
    assert.equal(url.href, TOKEN_URI);
    this.requests.push(body);
    if (this.mode === 'network') throw new TypeError('connection refused');
    if (this.mode === '503') return json({ error: 'temporarily_unavailable' }, 503);
    if (body.get('client_secret') !== SECRET || this.mode === 'invalid_client')
      return json({ error: 'invalid_client', error_description: 'Unauthorized' }, 401);
    if (this.mode === 'invalid_grant') return json({ error: 'invalid_grant' }, 400);
    const code = body.get('code') ?? '';
    const g = this.grants.get(code);
    this.grants.delete(code);
    if (
      g === undefined ||
      body.get('redirect_uri') !== g.redirect ||
      challengeOf(body.get('code_verifier') ?? '') !== g.challenge ||
      body.get('client_id') !== CLIENT_ID
    )
      return json({ error: 'invalid_grant' }, 400);
    return json({
      access_token: 'ya29.never-used',
      token_type: 'Bearer',
      expires_in: 3599,
      ...(this.returnRefreshToken ? { refresh_token: '1//google-refresh' } : {}),
      ...(this.mode === 'no_id_token'
        ? {}
        : {
            id_token: await this.idp.sign({
              sub: g.sub,
              aud: CLIENT_ID,
              claims: { nonce: g.nonce, email: 'must-not-be-stored@example.com' },
            }),
          }),
    });
  };
}

interface Rig {
  readonly idp: TestIdp;
  readonly google: FakeGoogleToken;
  readonly server: TestServer;
  readonly sessionsDir: string;
  readonly logger: CapturingLogger;
  readonly bindings: FsIdentityBindingStore;
  readonly bindDir: string;
  readonly events: { kind: string; last24h: number; limit: number }[];
  bind(sub: string): Promise<void>;
  challenge(): Promise<{ challengeId: string; nonce: string }>;
  /** A code Google would have issued for this sign-in attempt. */
  codeFor(nonce: string, sub: string, over?: Partial<Grant>): string;
  post(body: unknown): ReturnType<TestServer['request']>;
  stop(): Promise<void>;
}

let n = 0;
async function rig(
  opts: {
    withSecret?: boolean;
    selfSignup?: boolean;
    failCreate?: boolean;
    maxPerDay?: number;
    now?: () => number;
    challengePerMinute?: number;
    env?: Record<string, string>;
  } = {},
): Promise<Rig> {
  const idp = await TestIdp.start();
  const sessionsDir = await mkdtemp(join(tmpdir(), 'xo-code-sessions-'));
  const bindDir = await mkdtemp(join(tmpdir(), 'xo-code-bind-'));
  const realBindings = new FsIdentityBindingStore(bindDir);
  // A storage failure while provisioning: create() fails, find() still works.
  const bindings: FsIdentityBindingStore =
    opts.failCreate === true
      ? (Object.assign(Object.create(realBindings), {
          createIfAbsent: async () => ({ ok: false, error: new StorageError(ErrorCode.STORAGE_WRITE_FAILED, 'disk full') }),
        }) as FsIdentityBindingStore)
      : realBindings;
  const google = new FakeGoogleToken(idp);
  const config = loadSessionAuthConfig({
    XO_API_GOOGLE_CLIENT_ID: CLIENT_ID,
    XO_API_GOOGLE_ISSUER: idp.issuer,
    XO_API_GOOGLE_TOKEN_URI: TOKEN_URI,
    ...(opts.withSecret === false ? {} : { XO_API_GOOGLE_CLIENT_SECRET: SECRET }),
    XO_API_SESSIONS_DIR: sessionsDir,
    XO_API_OIDC_BINDINGS_DIR: bindDir,
    ...(opts.selfSignup === true ? { XO_API_SELF_SIGNUP: '1' } : {}),
    ...(opts.maxPerDay !== undefined ? { XO_API_SELF_SIGNUP_MAX_PER_DAY: String(opts.maxPerDay) } : {}),
  });
  assert.ok(config);
  const logger = new CapturingLogger();
  const events: { kind: string; last24h: number; limit: number }[] = [];
  const server = await TestServer.start({
    sessionAuth: createSessionAuth(config, {
      bindings,
      verifierTuning: { jwksCooldownMs: 0, discoveryRetryMs: 0, httpTimeoutMs: 2000 },
      codeExchangerOptions: { fetch: google.fetch as typeof fetch, timeoutMs: 2000 },
      onSelfSignupEvent: (e) => events.push({ ...e }),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      limits: {
        challenge: createRateLimiter({ windowMs: 60_000, max: opts.challengePerMinute ?? 1000 }),
        exchange: createRateLimiter({ windowMs: 60_000, max: 1000 }),
        refresh: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      },
    }),
    logger,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
  });
  return {
    idp,
    google,
    server,
    sessionsDir,
    logger,
    bindings,
    bindDir,
    events,
    async bind(sub) {
      const c = await bindings.create({
        bindingId: computeBindingId(idp.issuer, sub),
        issuer: idp.issuer,
        subject: sub,
        identityId: 'alice',
        principalKind: 'human',
        createdAt: new Date().toISOString(),
      });
      assert.ok(c.ok);
    },
    async challenge() {
      const res = await server.request('POST', '/auth/login-challenge', {}, {}, { skipAuth: true });
      assert.equal(res.status, 201);
      return res.json<{ challengeId: string; nonce: string }>();
    },
    codeFor(nonce, sub, over = {}) {
      const code = `gcode_${++n}`;
      google.issue(code, { nonce, sub, challenge: challengeOf(VERIFIER), redirect: REDIRECT, ...over });
      return code;
    },
    post: (body) => server.request('POST', '/auth/session', body, {}, { skipAuth: true }),
    async stop() {
      await server.stop();
      await idp.stop();
      await rm(sessionsDir, { recursive: true, force: true });
      await rm(bindDir, { recursive: true, force: true });
    },
  };
}

const errCode = (res: { json: <T>() => T }): string => res.json<{ error: { code: string } }>().error.code;
const errMessage = (res: { json: <T>() => T }): string => res.json<{ error: { message: string } }>().error.message;

test('code exchange: challenge -> code + PKCE verifier -> XO session; the client secret goes to Google only', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice');
    const c = await r.challenge();
    const code = r.codeFor(c.nonce, 'g-alice');
    const res = await r.post({ challengeId: c.challengeId, code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    assert.equal(res.status, 201, res.bodyText.slice(0, 200));
    assert.equal(res.headers['cache-control'], 'no-store');
    const b = res.json<{ accessCredential: string; refreshCredential: string }>();
    assert.match(b.accessCredential, /^xoas_/);
    assert.match(b.refreshCredential, /^xoar_/);

    const sent = r.google.requests[0];
    assert.ok(sent);
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('client_id'), CLIENT_ID);
    assert.equal(sent.get('client_secret'), SECRET);
    assert.equal(sent.get('code_verifier'), VERIFIER);
    assert.equal(sent.get('redirect_uri'), REDIRECT);

    // Nothing the client or an operator can read contains the secret, Google's access token or the email claim.
    for (const text of [res.bodyText, r.logger.lines.join('\n')]) {
      assert.ok(!text.includes(SECRET));
      assert.ok(!text.includes('ya29.never-used'));
      assert.ok(!text.includes('must-not-be-stored'));
    }
    for (const f of await readdir(r.sessionsDir, { recursive: true })) {
      if (!f.endsWith('.json')) continue;
      const txt = await readFile(join(r.sessionsDir, f), 'utf8');
      assert.ok(!txt.includes(SECRET) && !txt.includes('must-not-be-stored'), f);
    }
  } finally {
    await r.stop();
  }
});

test('the challenge is single-use: replaying the same code exchange is refused', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice');
    const c = await r.challenge();
    const code = r.codeFor(c.nonce, 'g-alice');
    const body = { challengeId: c.challengeId, code, codeVerifier: VERIFIER, redirectUri: REDIRECT };
    assert.equal((await r.post(body)).status, 201);
    const again = await r.post(body);
    assert.equal(again.status, 401);
    assert.equal(errCode(again), 'XO_AUTH_CHALLENGE_INVALID');
  } finally {
    await r.stop();
  }
});

test('without a configured client secret a code request is 501, and the ID-token path still works', async () => {
  const r = await rig({ withSecret: false });
  try {
    await r.bind('g-alice');
    const c = await r.challenge();
    const res = await r.post({ challengeId: c.challengeId, code: 'x', codeVerifier: VERIFIER, redirectUri: REDIRECT });
    assert.equal(res.status, 501);
    assert.equal(r.google.requests.length, 0, 'nothing was sent to Google');
    // The challenge was not consumed by the refused request, so the ID-token exchange for it still works.
    const idToken = await r.idp.sign({ sub: 'g-alice', aud: CLIENT_ID, claims: { nonce: c.nonce } });
    assert.equal((await r.post({ challengeId: c.challengeId, idToken })).status, 201);
  } finally {
    await r.stop();
  }
});

test('exactly one of idToken or code is accepted', async () => {
  const r = await rig();
  try {
    const c = await r.challenge();
    const both = await r.post({ challengeId: c.challengeId, idToken: 'a.b.c', code: 'x', codeVerifier: VERIFIER, redirectUri: REDIRECT });
    assert.equal(both.status, 400);
    const neither = await r.post({ challengeId: c.challengeId });
    assert.equal(neither.status, 400);
    assert.equal(r.google.requests.length, 0);
  } finally {
    await r.stop();
  }
});

test('malformed code, verifier or redirect address is refused before anything is sent to Google and without burning the challenge', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice');
    const c = await r.challenge();
    const good = { challengeId: c.challengeId, code: r.codeFor(c.nonce, 'g-alice'), codeVerifier: VERIFIER, redirectUri: REDIRECT };
    const bad: Array<Record<string, string>> = [
      { codeVerifier: 'short' },
      { codeVerifier: `${'v'.repeat(42)}!` },
      { code: 'has space' },
      { code: 'c'.repeat(2049) },
      { redirectUri: 'http://evil.test:53124/callback' },
      { redirectUri: 'https://127.0.0.1:53124/callback' },
      { redirectUri: 'http://localhost:53124/callback' },
      { redirectUri: 'http://127.0.0.1:80/callback' },
      { redirectUri: 'http://127.0.0.1:70000/callback' },
      { redirectUri: 'http://127.0.0.1:53124/callback?x=1' },
      { redirectUri: 'http://127.0.0.1:53124/other' },
      { redirectUri: 'http://u:p@127.0.0.1:53124/callback' },
    ];
    for (const override of bad) {
      const res = await r.post({ ...good, ...override });
      assert.equal(res.status, 400, JSON.stringify(override));
    }
    assert.equal(r.google.requests.length, 0);
    assert.equal((await r.post(good)).status, 201, 'the same challenge still works after the refused attempts');
  } finally {
    await r.stop();
  }
});

test('Google refusing the client (wrong or revoked secret) is a 401 that names only the error code, and consumes the challenge', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice');
    r.google.mode = 'invalid_client';
    const c = await r.challenge();
    const body = { challengeId: c.challengeId, code: r.codeFor(c.nonce, 'g-alice'), codeVerifier: VERIFIER, redirectUri: REDIRECT };
    const res = await r.post(body);
    assert.equal(res.status, 401);
    assert.equal(errCode(res), 'XO_AUTH_TOKEN_INVALID');
    assert.match(errMessage(res), /refused the sign-in \(invalid_client\)/);
    assert.ok(!res.bodyText.includes(SECRET));
    r.google.mode = 'ok';
    assert.equal(errCode(await r.post(body)), 'XO_AUTH_CHALLENGE_INVALID');
  } finally {
    await r.stop();
  }
});

test('an expired or already-used Google code is a plain "start again" 401', async () => {
  const r = await rig();
  try {
    r.google.mode = 'invalid_grant';
    const c = await r.challenge();
    const res = await r.post({ challengeId: c.challengeId, code: 'gone', codeVerifier: VERIFIER, redirectUri: REDIRECT });
    assert.equal(res.status, 401);
    assert.equal(errCode(res), 'XO_AUTH_TOKEN_INVALID');
    assert.match(errMessage(res), /invalid or has expired/);
  } finally {
    await r.stop();
  }
});

test('a Google outage is a 503 (fail closed, retryable), not a credential verdict', async () => {
  const r = await rig();
  try {
    for (const mode of ['503', 'network'] as const) {
      r.google.mode = mode;
      const c = await r.challenge();
      const res = await r.post({ challengeId: c.challengeId, code: 'x', codeVerifier: VERIFIER, redirectUri: REDIRECT });
      assert.equal(res.status, 503, mode);
      assert.equal(errCode(res), 'XO_AUTH_PROVIDER_UNAVAILABLE');
    }
  } finally {
    await r.stop();
  }
});

test('a code redeemed for ANOTHER attempt (wrong nonce) is refused, and a missing ID token is refused', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice');
    const mine = await r.challenge();
    const theirs = await r.challenge();
    const stolen = r.codeFor(theirs.nonce, 'g-alice'); // issued for the other sign-in attempt
    const res = await r.post({ challengeId: mine.challengeId, code: stolen, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    assert.equal(res.status, 401);
    assert.equal(errCode(res), 'XO_AUTH_TOKEN_INVALID');

    r.google.mode = 'no_id_token';
    const c = await r.challenge();
    const none = await r.post({
      challengeId: c.challengeId,
      code: r.codeFor(c.nonce, 'g-alice'),
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });
    assert.equal(none.status, 401);
  } finally {
    await r.stop();
  }
});

test('a verified but unbound identity is refused and recorded as (issuer, sub) only, exactly like the ID-token path', async () => {
  const r = await rig();
  try {
    const c = await r.challenge();
    const res = await r.post({
      challengeId: c.challengeId,
      code: r.codeFor(c.nonce, 'g-stranger'),
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });
    assert.equal(res.status, 401);
    assert.equal(errCode(res), 'XO_AUTH_IDENTITY_UNBOUND');
    const files = (await readdir(join(r.sessionsDir, 'unbound-logins'))).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const rec = await readFile(join(r.sessionsDir, 'unbound-logins', files[0] as string), 'utf8');
    assert.ok(rec.includes('g-stranger') && !rec.includes('must-not-be-stored') && !rec.includes(SECRET));
  } finally {
    await r.stop();
  }
});

test('a refresh token Google happens to issue is revoked best-effort and never stored', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice');
    r.google.returnRefreshToken = true;
    const c = await r.challenge();
    const res = await r.post({
      challengeId: c.challengeId,
      code: r.codeFor(c.nonce, 'g-alice'),
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
    });
    assert.equal(res.status, 201);
    for (let i = 0; i < 20 && r.google.revoked.length === 0; i++) await new Promise((x) => setTimeout(x, 25));
    assert.deepEqual(r.google.revoked, ['1//google-refresh']);
    assert.ok(!res.bodyText.includes('1//google-refresh'));
    for (const f of await readdir(r.sessionsDir, { recursive: true })) {
      if (f.endsWith('.json')) assert.ok(!(await readFile(join(r.sessionsDir, f), 'utf8')).includes('1//google-refresh'), f);
    }
  } finally {
    await r.stop();
  }
});

test('configuration: the secret needs the client id, is validated, and is never echoed in an error', () => {
  assert.throws(() => loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_SECRET: SECRET }), /XO_API_GOOGLE_CLIENT_SECRET/);
  for (const bad of ['has space', 'x'.repeat(257), 'tab\there']) {
    try {
      loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_CLIENT_SECRET: bad });
      assert.fail('expected a configuration error');
    } catch (e) {
      const msg = String((e as Error).message);
      assert.match(msg, /XO_API_GOOGLE_CLIENT_SECRET/);
      assert.ok(!msg.includes(bad));
    }
  }
  assert.throws(
    () => loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_TOKEN_URI: 'http://evil.example/token' }),
    /XO_API_GOOGLE_TOKEN_URI/,
  );
  const ok = loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_CLIENT_SECRET: SECRET });
  assert.equal(ok?.tokenUri, 'https://oauth2.googleapis.com/token');
  // Without a secret there is no code exchange.
  assert.equal(loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID })?.clientSecret, undefined);
});

async function signIn(r: Rig, sub: string): ReturnType<Rig['post']> {
  const c = await r.challenge();
  const code = r.codeFor(c.nonce, sub);
  return r.post({ challengeId: c.challengeId, code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
}

test('self sign-up is off by default: an unbound identity is still refused', async () => {
  const r = await rig();
  try {
    const res = await signIn(r, 'g-newcomer');
    assert.equal(res.status, 401);
    assert.equal(errCode(res), 'XO_AUTH_IDENTITY_UNBOUND');
    const found = await r.bindings.find(r.idp.issuer, 'g-newcomer');
    assert.ok(found.ok && found.value === undefined);
  } finally {
    await r.stop();
  }
});

test('self sign-up: a new verified identity gets its own personal identity and NO organisation; two customers never share an identity', async () => {
  const r = await rig({ selfSignup: true });
  try {
    assert.equal((await signIn(r, 'g-one')).status, 201);
    assert.equal((await signIn(r, 'g-two')).status, 201);
    const a = await r.bindings.find(r.idp.issuer, 'g-one');
    const b = await r.bindings.find(r.idp.issuer, 'g-two');
    assert.ok(a.ok && a.value !== undefined && b.ok && b.value !== undefined);
    assert.match(a.value.identityId, /^usr_[0-9a-f]{24}$/);
    assert.equal(a.value.orgId, undefined);
    assert.equal(b.value.orgId, undefined);
    assert.notEqual(a.value.identityId, b.value.identityId);
    assert.equal(a.value.principalKind, 'human');
    // Signing in again reuses the same identity rather than creating another.
    assert.equal((await signIn(r, 'g-one')).status, 201);
    const again = await r.bindings.find(r.idp.issuer, 'g-one');
    assert.ok(again.ok && again.value?.identityId === a.value.identityId);
  } finally {
    await r.stop();
  }
});

test('self sign-up never overrides an operator revocation', async () => {
  const r = await rig({ selfSignup: true });
  try {
    assert.equal((await signIn(r, 'g-banned')).status, 201);
    const rev = await r.bindings.revoke(r.idp.issuer, 'g-banned');
    assert.ok(rev.ok);
    const res = await signIn(r, 'g-banned');
    assert.equal(res.status, 401);
    assert.equal(errCode(res), 'XO_AUTH_IDENTITY_UNBOUND');
  } finally {
    await r.stop();
  }
});

test('self sign-up still requires a verified Google identity: a wrong nonce provisions nothing', async () => {
  const r = await rig({ selfSignup: true });
  try {
    const c = await r.challenge();
    const code = r.codeFor('not-the-nonce', 'g-forged');
    const res = await r.post({ challengeId: c.challengeId, code, codeVerifier: VERIFIER, redirectUri: REDIRECT });
    assert.equal(res.status, 401);
    const found = await r.bindings.find(r.idp.issuer, 'g-forged');
    assert.ok(found.ok && found.value === undefined);
  } finally {
    await r.stop();
  }
});

test('self sign-up: personal work stays private to its owner, and an unauthenticated caller sees nothing', async () => {
  const r = await rig({ selfSignup: true });
  try {
    const tokens = async (sub: string): Promise<string> => (await signIn(r, sub)).json<{ accessCredential: string }>().accessCredential;
    const a = await tokens('g-priv-a');
    const b = await tokens('g-priv-b');
    const as = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });
    const made = await r.server.request('POST', '/workspaces', { name: 'A private' }, as(a), { skipAuth: true });
    assert.equal(made.status, 201, made.bodyText.slice(0, 200));
    const wsId = made.json<{ workspaceId: string }>().workspaceId;

    const listA = await r.server.request('GET', '/workspaces', undefined, as(a), { skipAuth: true });
    assert.ok(listA.bodyText.includes(wsId));
    const listB = await r.server.request('GET', '/workspaces', undefined, as(b), { skipAuth: true });
    assert.equal(listB.status, 200);
    assert.ok(!listB.bodyText.includes(wsId));
    const intoA = await r.server.request('GET', `/workspaces/${wsId}/executions`, undefined, as(b), { skipAuth: true });
    assert.ok(intoA.status === 403 || intoA.status === 404, `expected 403/404, got ${intoA.status}`);
    const anon = await r.server.request('GET', '/workspaces', undefined, {}, { skipAuth: true });
    assert.equal(anon.status, 401);
  } finally {
    await r.stop();
  }
});

test('self sign-up: concurrent first sign-ins of the same account leave exactly one consistent binding', async () => {
  const r = await rig({ selfSignup: true });
  try {
    const results = await Promise.all([signIn(r, 'g-race'), signIn(r, 'g-race'), signIn(r, 'g-race')]);
    assert.deepEqual(
      results.map((x) => x.status),
      [201, 201, 201],
    );
    const list = await r.bindings.list();
    assert.ok(list.ok);
    assert.equal(list.value.filter((x) => x.subject === 'g-race').length, 1);
  } finally {
    await r.stop();
  }
});

test('self sign-up: a storage failure while provisioning is a retryable 503 and grants no session', async () => {
  const r = await rig({ selfSignup: true, failCreate: true });
  try {
    const res = await signIn(r, 'g-disk');
    assert.equal(res.status, 503);
    const found = await r.bindings.find(r.idp.issuer, 'g-disk');
    assert.ok(found.ok && found.value === undefined);
  } finally {
    await r.stop();
  }
});

test('development access key: same trusted-principal path and the same isolation as a session; a bad key is refused', async () => {
  const r = await rig({ selfSignup: true });
  try {
    // The server's default credential is a development access key (xoak_) bound to its own identity.
    const keyMade = await r.server.request('POST', '/workspaces', { name: 'key-owned' });
    assert.equal(keyMade.status, 201);
    const keyWs = keyMade.json<{ workspaceId: string; identityId: string }>();
    assert.equal(keyWs.identityId, r.server.identityId); // derived from the key's server-side record, not from the request

    const access = (await signIn(r, 'g-vs-key')).json<{ accessCredential: string }>().accessCredential;
    const bearer = { authorization: `Bearer ${access}` };
    const sessMade = await r.server.request('POST', '/workspaces', { name: 'session-owned' }, bearer, { skipAuth: true });
    assert.equal(sessMade.status, 201);
    const sessWs = sessMade.json<{ workspaceId: string; identityId: string }>();
    assert.notEqual(sessWs.identityId, keyWs.identityId);

    // Neither credential type can see or enter the other's workspace.
    const keyList = await r.server.request('GET', '/workspaces');
    assert.ok(keyList.bodyText.includes(keyWs.workspaceId) && !keyList.bodyText.includes(sessWs.workspaceId));
    const sessList = await r.server.request('GET', '/workspaces', undefined, bearer, { skipAuth: true });
    assert.ok(sessList.bodyText.includes(sessWs.workspaceId) && !sessList.bodyText.includes(keyWs.workspaceId));
    const cross = await r.server.request('GET', `/workspaces/${sessWs.workspaceId}/executions`);
    assert.ok(cross.status === 403 || cross.status === 404, `expected 403/404, got ${cross.status}`);

    // A client-supplied identity or organisation is ignored, and an unknown key is a 401.
    const spoof = await r.server.request('GET', '/workspaces', undefined, { 'x-xo-identity': sessWs.identityId, 'x-xo-org': 'org_other' });
    assert.ok(!spoof.bodyText.includes(sessWs.workspaceId));
    const bad = await r.server.request(
      'GET',
      '/workspaces',
      undefined,
      { authorization: 'Bearer xoak_not-a-real-key' },
      { skipAuth: true },
    );
    assert.equal(bad.status, 401);
  } finally {
    await r.stop();
  }
});

test('self sign-up cannot overwrite a corrupt existing record: 503, the file is untouched, no session', async () => {
  const r = await rig({ selfSignup: true });
  try {
    const file = join(r.bindDir, 'identity-bindings', 'by-subject', `${computeBindingId(r.idp.issuer, 'g-corrupt')}.json`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{corrupt');
    const res = await signIn(r, 'g-corrupt');
    assert.equal(res.status, 503);
    assert.ok(!res.bodyText.includes('xoas_'));
    assert.equal(await readFile(file, 'utf8'), '{corrupt');
  } finally {
    await r.stop();
  }
});

test('self sign-up leaves a manually bound account exactly as the operator made it', async () => {
  const r = await rig({ selfSignup: true });
  try {
    await r.bind('g-manual'); // identity "alice", set by the operator
    const res = await signIn(r, 'g-manual');
    assert.equal(res.status, 201);
    const found = await r.bindings.find(r.idp.issuer, 'g-manual');
    assert.ok(found.ok && found.value?.identityId === 'alice');
  } finally {
    await r.stop();
  }
});

test('account-creation cap: new accounts stop at the limit, existing users are unaffected, and the cap raises an alert event', async () => {
  const r = await rig({ selfSignup: true, maxPerDay: 3 });
  try {
    assert.equal((await signIn(r, 'cap-1')).status, 201);
    assert.equal((await signIn(r, 'cap-2')).status, 201);
    assert.deepEqual(r.events, []); // 2 of 3 is still under the 80% warning line
    assert.equal((await signIn(r, 'cap-3')).status, 201);
    assert.ok(r.events.some((e) => e.kind === 'near_cap' && e.last24h === 3));
    const refused = await signIn(r, 'cap-4');
    assert.equal(refused.status, 429);
    assert.equal(errCode(refused), 'XO_AUTH_RATE_LIMITED');
    assert.ok(!refused.bodyText.includes('xoas_'));
    const none = await r.bindings.find(r.idp.issuer, 'cap-4');
    assert.ok(none.ok && none.value === undefined);
    assert.ok(r.events.some((e) => e.kind === 'cap_reached' && e.last24h === 3 && e.limit === 3));
    // People who already have an account are never blocked by the cap.
    assert.equal((await signIn(r, 'cap-1')).status, 201);
    // The alert carries counts only.
    assert.ok(r.events.every((e) => Object.keys(e).sort().join() === 'kind,last24h,limit'));
  } finally {
    await r.stop();
  }
});

test('account-creation cap is a rolling 24-hour window and does not count operator-made bindings', async () => {
  let clock = Date.now();
  const r = await rig({ selfSignup: true, maxPerDay: 1, now: () => clock });
  try {
    await r.bind('operator-made'); // identity "alice": not a self-signup, not counted
    assert.equal((await signIn(r, 'win-1')).status, 201);
    assert.equal((await signIn(r, 'win-2')).status, 429);
    clock += 25 * 60 * 60 * 1000;
    assert.equal((await signIn(r, 'win-2')).status, 201);
  } finally {
    await r.stop();
  }
});

test('account-creation cap fails closed (503) when the existing accounts cannot be counted', async () => {
  const r = await rig({ selfSignup: true, maxPerDay: 5 });
  try {
    r.bindings.list = async () => ({ ok: false, error: new Error('read failed') }) as never;
    const res = await signIn(r, 'cap-unreadable');
    assert.equal(res.status, 503);
    assert.ok(!res.bodyText.includes('xoas_'));
  } finally {
    await r.stop();
  }
});

test('account-creation cap configuration is validated, and the default is 200 a day', async () => {
  const base = { XO_API_GOOGLE_CLIENT_ID: CLIENT_ID };
  assert.equal(loadSessionAuthConfig(base)?.selfSignupMaxPerDay, 200);
  assert.equal(loadSessionAuthConfig({ ...base, XO_API_SELF_SIGNUP_MAX_PER_DAY: '50' })?.selfSignupMaxPerDay, 50);
  for (const bad of ['0', '-1', '1.5', 'many', '2000000'])
    assert.throws(() => loadSessionAuthConfig({ ...base, XO_API_SELF_SIGNUP_MAX_PER_DAY: bad }), /XO_API_SELF_SIGNUP_MAX_PER_DAY/);
  assert.equal(loadSessionAuthConfig(base)?.selfSignup, false); // still off by default
});

test('behind a trusted proxy, rate limits follow the real client address and a spoofed header cannot dodge them', async () => {
  const challenge = async (r: Rig, headers: Record<string, string>): Promise<number> =>
    (await r.server.request('POST', '/auth/login-challenge', {}, headers, { skipAuth: true })).status;

  const proxied = await rig({ challengePerMinute: 2, env: { XO_API_TRUSTED_PROXY_HOPS: '1' } });
  try {
    // One proxy hop: the proxy appends the real client address; anything the client put before it is ignored.
    assert.equal(await challenge(proxied, { 'x-forwarded-for': 'spoof-1, 203.0.113.7' }), 201);
    assert.equal(await challenge(proxied, { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' }), 201);
    assert.equal(await challenge(proxied, { 'x-forwarded-for': '192.0.2.1, 203.0.113.7' }), 429); // same real client: limited
    assert.equal(await challenge(proxied, { 'x-forwarded-for': '203.0.113.8' }), 201); // a different real client is not
  } finally {
    await proxied.stop();
  }

  const direct = await rig({ challengePerMinute: 2 });
  try {
    // No trusted proxy configured: the header is ignored, so rotating it does not escape the limit.
    assert.equal(await challenge(direct, { 'x-forwarded-for': '203.0.113.1' }), 201);
    assert.equal(await challenge(direct, { 'x-forwarded-for': '203.0.113.2' }), 201);
    assert.equal(await challenge(direct, { 'x-forwarded-for': '203.0.113.3' }), 429);
  } finally {
    await direct.stop();
  }
});

const WORKSPACE_GET_ROUTES = ['', '/sources', '/compilations', '/executions', '/human-tasks', '/workflows', '/workflow-executions'];

test('self-signed-up people cannot reach each other through any workspace route family; no credential gets 401', async () => {
  const r = await rig({ selfSignup: true });
  try {
    const tok = async (sub: string): Promise<Record<string, string>> => ({
      authorization: `Bearer ${(await signIn(r, sub)).json<{ accessCredential: string }>().accessCredential}`,
    });
    const a = await tok('sweep-a');
    const b = await tok('sweep-b');
    const wsId = (await r.server.request('POST', '/workspaces', { name: 'A' }, a, { skipAuth: true })).json<{ workspaceId: string }>()
      .workspaceId;
    for (const suffix of WORKSPACE_GET_ROUTES) {
      const path = `/workspaces/${wsId}${suffix}`;
      const own = await r.server.request('GET', path, undefined, a, { skipAuth: true });
      assert.ok(own.status < 400, `owner must reach ${path} (got ${own.status})`);
      const other = await r.server.request('GET', path, undefined, b, { skipAuth: true });
      assert.equal(other.status, 404, `another person must get 404 on ${path}`);
      const anon = await r.server.request('GET', path, undefined, {}, { skipAuth: true });
      assert.equal(anon.status, 401, `${path} without a credential`);
    }
    const upload = await r.server.request('POST', `/workspaces/${wsId}/sources`, { name: 'x.txt', content: 'hello' }, b, {
      skipAuth: true,
    });
    assert.equal(upload.status, 404);
  } finally {
    await r.stop();
  }
});
