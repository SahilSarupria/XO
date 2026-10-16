import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, generateKeyPair } from 'jose';
import { ErrorCode } from '@xo/errors';
import { TestServer } from './test-helpers.js';
import { TestIdp, CapturingLogger } from './oidc-test-idp.js';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';
import { loadSessionAuthConfig, GOOGLE_ISSUER } from '../src/auth/session/config.js';
import { createSessionAuth, defaultLimits } from '../src/auth/session/bundle.js';
import { createRateLimiter } from '../src/auth/session/rate-limiter.js';
import { createIdTokenVerifier } from '../src/auth/session/id-token-verifier.js';
import type { SessionLimits } from '../src/auth/session/service.js';

const CLIENT_ID = '1234567890-xotest.apps.googleusercontent.com';

interface Rig {
  readonly idp: TestIdp;
  readonly server: TestServer;
  readonly bindings: FsIdentityBindingStore;
  readonly sessionsDir: string;
  readonly logger: CapturingLogger;
  readonly clock: { t: number };
  bind(sub: string, identityId: string): Promise<void>;
  idToken(sub: string, nonce: string, over?: Parameters<TestIdp['sign']>[0]): Promise<string>;
  challenge(): Promise<{ challengeId: string; nonce: string }>;
  exchange(challengeId: string, idToken: string): ReturnType<TestServer['request']>;
  login(sub: string): Promise<{ access: string; refresh: string }>;
  call(method: string, path: string, token: string, body?: unknown): ReturnType<TestServer['request']>;
  refresh(refreshCredential: string): ReturnType<TestServer['request']>;
  rebuild(): Promise<TestServer>;
  stop(): Promise<void>;
}

async function rig(opts: { limits?: SessionLimits; maxOutstanding?: number; also?: object } = {}): Promise<Rig> {
  const idp = await TestIdp.start();
  const sessionsDir = await mkdtemp(join(tmpdir(), 'xo-sessions-'));
  const bindDir = await mkdtemp(join(tmpdir(), 'xo-sbind-'));
  const bindings = new FsIdentityBindingStore(bindDir);
  const clock = { t: Date.now() };
  const config = loadSessionAuthConfig({
    XO_API_GOOGLE_CLIENT_ID: CLIENT_ID,
    XO_API_GOOGLE_ISSUER: idp.issuer,
    XO_API_SESSIONS_DIR: sessionsDir,
    XO_API_OIDC_BINDINGS_DIR: bindDir,
  });
  assert.ok(config);
  const logger = new CapturingLogger();
  const build = (): ReturnType<typeof createSessionAuth> =>
    createSessionAuth(config, {
      bindings,
      verifierTuning: { jwksCooldownMs: 0, discoveryRetryMs: 0, httpTimeoutMs: 2000 },
      session: { now: () => clock.t },
      challenge: { now: () => clock.t, ...(opts.maxOutstanding !== undefined ? { maxOutstanding: opts.maxOutstanding } : {}) },
      limits: opts.limits ?? {
        challenge: createRateLimiter({ windowMs: 60_000, max: 1000 }),
        exchange: createRateLimiter({ windowMs: 60_000, max: 1000 }),
        refresh: createRateLimiter({ windowMs: 60_000, max: 1000 }),
      },
    });
  let server = await TestServer.start({ sessionAuth: build(), logger, ...(opts.also ?? {}) });
  const r: Rig = {
    idp,
    get server() {
      return server;
    },
    bindings,
    sessionsDir,
    logger,
    clock,
    async bind(sub, identityId) {
      const c = await bindings.create({
        bindingId: computeBindingId(idp.issuer, sub),
        issuer: idp.issuer,
        subject: sub,
        identityId,
        principalKind: 'human',
        createdAt: new Date().toISOString(),
      });
      assert.ok(c.ok);
    },
    idToken: (sub, nonce, over = {}) =>
      idp.sign({ sub, aud: CLIENT_ID, ...over, claims: { nonce, email: 'must-not-be-stored@example.com', ...(over.claims ?? {}) } }),
    async challenge() {
      const res = await server.request('POST', '/auth/login-challenge', {}, {}, { skipAuth: true });
      assert.equal(res.status, 201);
      return res.json<{ challengeId: string; nonce: string }>();
    },
    exchange: (challengeId, idToken) => server.request('POST', '/auth/session', { challengeId, idToken }, {}, { skipAuth: true }),
    async login(sub) {
      const c = await r.challenge();
      const res = await r.exchange(c.challengeId, await r.idToken(sub, c.nonce));
      assert.equal(res.status, 201, res.bodyText.slice(0, 200));
      const b = res.json<{ accessCredential: string; refreshCredential: string }>();
      return { access: b.accessCredential, refresh: b.refreshCredential };
    },
    call: (method, path, token, body) => server.request(method, path, body, { authorization: `Bearer ${token}` }, { skipAuth: true }),
    refresh: (refreshCredential) => server.request('POST', '/auth/refresh', { refreshCredential }, {}, { skipAuth: true }),
    async rebuild() {
      await server.stop();
      server = await TestServer.start({ sessionAuth: build(), logger });
      return server;
    },
    async stop() {
      await server.stop();
      await idp.stop();
      await rm(sessionsDir, { recursive: true, force: true });
      await rm(bindDir, { recursive: true, force: true });
    },
  };
  return r;
}

const code = (res: { json: <T>() => T }): string => res.json<{ error: { code: string } }>().error.code;
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- the happy path and its shape

test('sign-in: challenge -> Google ID token -> XO session; the access credential authenticates as the bound principal', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const res = await r.server.request('POST', '/auth/login-challenge', {}, {}, { skipAuth: true });
    assert.equal(res.status, 201);
    assert.equal(res.headers['cache-control'], 'no-store');
    const c = res.json<{ challengeId: string; nonce: string; expiresAt: string }>();
    assert.match(c.challengeId, /^[A-Za-z0-9_-]{43}$/);
    assert.match(c.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Date.parse(c.expiresAt) - r.clock.t, 5 * 60 * 1000);

    const ex = await r.exchange(c.challengeId, await r.idToken('g-alice', c.nonce));
    assert.equal(ex.status, 201);
    assert.equal(ex.headers['cache-control'], 'no-store');
    const s = ex.json<{ accessCredential: string; refreshCredential: string; accessExpiresAt: string; refreshExpiresAt: string }>();
    assert.match(s.accessCredential, /^xoas_[A-Za-z0-9_-]{43}$/);
    assert.match(s.refreshCredential, /^xoar_[A-Za-z0-9_-]{43}$/);
    assert.equal(Date.parse(s.accessExpiresAt) - r.clock.t, 15 * 60 * 1000);

    // Authenticated as alice: she owns the workspace she creates; another bound identity cannot see it.
    const created = await r.call('POST', '/workspaces', s.accessCredential, { name: 'w', identityId: 'bob' });
    assert.equal(created.status, 201);
    const wsId = created.json<{ workspaceId: string }>().workspaceId;
    assert.equal((await r.call('GET', `/workspaces/${wsId}`, s.accessCredential)).status, 200);
    await r.bind('g-bob', 'bob');
    const bob = await r.login('g-bob');
    assert.equal((await r.call('GET', `/workspaces/${wsId}`, bob.access)).status, 404, 'cross-session, cross-principal isolation');
  } finally {
    await r.stop();
  }
});

test('an unbound Google identity is refused, is not provisioned, and appears (issuer, sub, time only) in the operator-only list', async () => {
  const r = await rig();
  try {
    const c = await r.challenge();
    const res = await r.exchange(c.challengeId, await r.idToken('g-stranger', c.nonce));
    assert.equal(res.status, 401);
    assert.equal(code(res), ErrorCode.AUTH_IDENTITY_UNBOUND);
    assert.ok(!res.bodyText.includes('g-stranger'), 'the response does not echo the subject');
    const listed = await r.bindings.list();
    assert.ok(listed.ok && listed.value.length === 0, 'nothing was provisioned');

    const files = (await walk(join(r.sessionsDir, 'unbound-logins'))).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const entry = JSON.parse(await readFile(files[0] as string, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(entry).sort(), ['at', 'issuer', 'subject']);
    assert.equal(entry['issuer'], r.idp.issuer);
    assert.equal(entry['subject'], 'g-stranger');
    const all = (await Promise.all((await walk(r.sessionsDir)).map((f) => readFile(f, 'utf8')))).join('\n');
    assert.ok(!all.includes('must-not-be-stored@example.com'), 'no email anywhere on disk');

    // No HTTP route exposes it.
    await r.bind('g-stranger', 'stranger');
    for (const path of ['/auth/unbound', '/auth/unbound-logins', '/auth/bindings']) {
      const probe = await r.server.request('GET', path);
      assert.ok(probe.status === 404 || probe.status === 405, path);
    }
    const again = await r.login('g-stranger');
    assert.match(again.access, /^xoas_/);
  } finally {
    await r.stop();
  }
});

test('the unbound list is bounded: capped, aged out, and refills only from verified identities', async () => {
  const r = await rig({
    limits: {
      challenge: createRateLimiter({ windowMs: 1, max: 10_000 }),
      exchange: createRateLimiter({ windowMs: 1, max: 10_000 }),
      refresh: createRateLimiter({ windowMs: 1, max: 10_000 }),
    },
  });
  try {
    for (let i = 0; i < 105; i++) {
      const c = await r.challenge();
      const res = await r.exchange(c.challengeId, await r.idToken(`g-user-${i}`, c.nonce));
      assert.equal(code(res), ErrorCode.AUTH_IDENTITY_UNBOUND);
    }
    const files = (await readdir(join(r.sessionsDir, 'unbound-logins'))).filter((f) => f.endsWith('.json'));
    assert.ok(files.length <= 100, `bounded to 100, found ${files.length}`);
    // An unverified attempt (bad signature) never writes an entry.
    const before = files.length;
    const { privateKey } = await generateKeyPair('RS256');
    const c = await r.challenge();
    const forged = await new SignJWT({ nonce: c.nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(r.idp.issuer)
      .setAudience(CLIENT_ID)
      .setSubject('forged-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    assert.equal(code(await r.exchange(c.challengeId, forged)), ErrorCode.AUTH_TOKEN_INVALID);
    const after = (await readdir(join(r.sessionsDir, 'unbound-logins'))).filter((f) => f.endsWith('.json')).length;
    assert.equal(after, before);
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------- ID-token verification

test('ID-token failures are refused with the documented codes, and each consumes the challenge', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, (nonce: string) => Promise<string>, string]> = [
      ['wrong nonce', (n) => r.idToken('g-alice', `${n}x`), ErrorCode.AUTH_TOKEN_INVALID],
      ['nonce of another challenge', async () => r.idToken('g-alice', (await r.challenge()).nonce), ErrorCode.AUTH_TOKEN_INVALID],
      [
        'missing nonce',
        (n) => r.idp.sign({ sub: 'g-alice', aud: CLIENT_ID, claims: { nonce: undefined, note: n } }),
        ErrorCode.AUTH_TOKEN_INVALID,
      ],
      [
        'wrong audience',
        (n) => r.idToken('g-alice', n, { aud: 'another-client.apps.googleusercontent.com' }),
        ErrorCode.AUTH_TOKEN_INVALID,
      ],
      ['wrong issuer', (n) => r.idToken('g-alice', n, { iss: 'https://evil.example' }), ErrorCode.AUTH_TOKEN_INVALID],
      ['expired', (n) => r.idToken('g-alice', n, { iat: now - 7200, exp: now - 3600 }), ErrorCode.AUTH_TOKEN_EXPIRED],
      ['issued in the future', (n) => r.idToken('g-alice', n, { iat: now + 3600, exp: now + 7200 }), ErrorCode.AUTH_TOKEN_INVALID],
      ['missing sub', (n) => r.idToken(undefined as unknown as string, n, { sub: undefined }), ErrorCode.AUTH_TOKEN_INVALID],
      ['azp that is not our client', (n) => r.idToken('g-alice', n, { claims: { azp: 'someone-else' } }), ErrorCode.AUTH_TOKEN_INVALID],
      ['several audiences without azp', (n) => r.idToken('g-alice', n, { aud: [CLIENT_ID, 'other'] }), ErrorCode.AUTH_TOKEN_INVALID],
      ['unsupported typ', (n) => r.idToken('g-alice', n, { typ: 'at+jwt' }), ErrorCode.AUTH_TOKEN_INVALID],
      ['garbage', async () => 'aaa.bbb.ccc', ErrorCode.AUTH_TOKEN_INVALID],
      ['empty', async () => '', ErrorCode.INVALID_ARGUMENT],
    ];
    for (const [name, make, expected] of cases) {
      const c = await r.challenge();
      const token = await make(c.nonce);
      const res = await r.exchange(c.challengeId, token);
      assert.equal(code(res), expected, name);
      assert.ok(!res.bodyText.includes(token) || token.length === 0, `${name}: token echoed`);
      const retry = await r.exchange(c.challengeId, await r.idToken('g-alice', c.nonce));
      if (expected === ErrorCode.INVALID_ARGUMENT) {
        // A malformed REQUEST is rejected before any exchange is attempted, so it does not spend the challenge.
        assert.equal(retry.status, 201, `${name}: a malformed request does not consume the challenge`);
      } else {
        // Every real exchange attempt consumes the challenge: it cannot be tried again.
        assert.equal(code(retry), ErrorCode.AUTH_CHALLENGE_INVALID, `${name}: challenge must be spent`);
      }
    }
  } finally {
    await r.stop();
  }
});

test('forged ID tokens: foreign key, tampered payload, alg none, HS256 keyed with the public JWK, oversize', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const attempts: Array<[string, (nonce: string) => Promise<string>]> = [
      [
        'foreign key',
        async (n) =>
          new SignJWT({ nonce: n })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(r.idp.issuer)
            .setAudience(CLIENT_ID)
            .setSubject('g-alice')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign((await generateKeyPair('RS256')).privateKey),
      ],
      [
        'tampered payload',
        async (n) => {
          const [h, p, s] = (await r.idToken('g-alice', n)).split('.') as [string, string, string];
          return `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'g-admin' })).toString('base64url')}.${s}`;
        },
      ],
      [
        'alg none',
        async (n) =>
          `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ iss: r.idp.issuer, aud: CLIENT_ID, sub: 'g-alice', nonce: n, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 })}.`,
      ],
      [
        'HS256 with public key as secret',
        async (n) => {
          const { createHmac } = await import('node:crypto');
          const head = enc({ alg: 'HS256', kid: 'k1', typ: 'JWT' });
          const body = enc({
            iss: r.idp.issuer,
            aud: CLIENT_ID,
            sub: 'g-alice',
            nonce: n,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 300,
          });
          return `${head}.${body}.${createHmac('sha256', JSON.stringify(r.idp.publicJwk('k1')))
            .update(`${head}.${body}`)
            .digest('base64url')}`;
        },
      ],
      [
        'oversize (verifier bound; the route also caps the field at 8 KiB)',
        async (n) => `${enc({ alg: 'RS256', kid: 'k1' })}.${Buffer.from('x'.repeat(10_000)).toString('base64url')}.${n}`,
      ],
    ];
    for (const [name, make] of attempts) {
      const c = await r.challenge();
      const res = await r.exchange(c.challengeId, await make(c.nonce));
      const oversize = name.startsWith('oversize');
      assert.equal(res.status, oversize ? 400 : 401, name);
      assert.equal(code(res), oversize ? ErrorCode.INVALID_ARGUMENT : ErrorCode.AUTH_TOKEN_INVALID, name);
    }
  } finally {
    await r.stop();
  }
});

test('issuer canonicalization: both documented Google spellings verify to the https form; nothing else does', async () => {
  const idp = await TestIdp.start();
  try {
    const config = loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_JWKS_URI: `${idp.issuer}/jwks` });
    assert.ok(config);
    assert.equal(config.issuer, GOOGLE_ISSUER);
    const verifier = createIdTokenVerifier(config, { jwksCooldownMs: 0 });
    const tok = (iss: string): Promise<string> => idp.sign({ iss, sub: 'g-1', aud: CLIENT_ID, claims: { nonce: 'n-1' } });
    for (const spelling of ['https://accounts.google.com', 'accounts.google.com']) {
      assert.deepEqual(await verifier.verify(await tok(spelling), 'n-1'), { issuer: GOOGLE_ISSUER, subject: 'g-1' });
    }
    for (const spelling of [
      'https://accounts.google.com/',
      'http://accounts.google.com',
      'https://accounts.google.com.evil.example',
      'ACCOUNTS.GOOGLE.COM',
    ]) {
      await assert.rejects(
        verifier.verify(await tok(spelling), 'n-1'),
        (e: { code?: string }) => e.code === ErrorCode.AUTH_TOKEN_INVALID,
        spelling,
      );
    }
    // With a non-Google issuer configured, the legacy Google spelling is NOT accepted.
    const other = loadSessionAuthConfig({
      XO_API_GOOGLE_CLIENT_ID: CLIENT_ID,
      XO_API_GOOGLE_ISSUER: 'https://idp.example',
      XO_API_GOOGLE_JWKS_URI: `${idp.issuer}/jwks`,
    });
    assert.ok(other);
    assert.deepEqual(other.acceptedIssuerClaims, ['https://idp.example']);
    await assert.rejects(
      createIdTokenVerifier(other, { jwksCooldownMs: 0 }).verify(await tok('accounts.google.com'), 'n-1'),
      (e: { code?: string }) => e.code === ErrorCode.AUTH_TOKEN_INVALID,
    );
  } finally {
    await idp.stop();
  }
});

test('the signing keys come only from the configured issuer: unknown kid, outage and malformed key sets fail closed', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const c1 = await r.challenge();
    await r.idp.addKey('k-hidden', 'RS256', false);
    assert.equal(
      code(await r.exchange(c1.challengeId, await r.idToken('g-alice', c1.nonce, { kid: 'k-hidden' }))),
      ErrorCode.AUTH_TOKEN_INVALID,
      'unknown kid',
    );
    for (const [name, setup, undo] of [
      ['JWKS 5xx', () => (r.idp.jwksStatus = 500), () => (r.idp.jwksStatus = 200)],
      ['malformed JWKS', () => (r.idp.jwksBody = 'not json'), () => (r.idp.jwksBody = undefined)],
      ['JWKS redirect', () => (r.idp.jwksRedirect = true), () => (r.idp.jwksRedirect = false)],
    ] as const) {
      await r.idp.addKey(`k-${name.replace(/\W/g, '')}`, 'RS256', false);
      setup();
      const c = await r.challenge();
      const res = await r.exchange(c.challengeId, await r.idToken('g-alice', c.nonce, { kid: `k-${name.replace(/\W/g, '')}` }));
      assert.equal(res.status, 503, name);
      assert.equal(code(res), ErrorCode.AUTH_PROVIDER_UNAVAILABLE, name);
      undo();
    }
    assert.ok((await r.login('g-alice')).access, 'recovers');
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------- challenges

test('challenges: single-use under concurrency, expire after 5 minutes, unknown or malformed ids refused, outstanding cap enforced', async () => {
  const r = await rig({ maxOutstanding: 4 });
  try {
    await r.bind('g-alice', 'alice');
    const c = await r.challenge();
    const token = await r.idToken('g-alice', c.nonce);
    const results = await Promise.all(Array.from({ length: 8 }, () => r.exchange(c.challengeId, token)));
    assert.equal(results.filter((x) => x.status === 201).length, 1, 'exactly one concurrent exchange wins');
    assert.ok(results.filter((x) => x.status !== 201).every((x) => x.status === 401 && code(x) === ErrorCode.AUTH_CHALLENGE_INVALID));
    const files = (await walk(join(r.sessionsDir, 'sessions', 'families'))).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, 'one session was created');
    // Replay of the spent challenge.
    assert.equal(code(await r.exchange(c.challengeId, token)), ErrorCode.AUTH_CHALLENGE_INVALID);

    const expiring = await r.challenge();
    r.clock.t += 5 * 60 * 1000 + 1000;
    assert.equal(
      code(await r.exchange(expiring.challengeId, await r.idToken('g-alice', expiring.nonce))),
      ErrorCode.AUTH_CHALLENGE_INVALID,
    );

    for (const bad of ['x'.repeat(43), 'short', '../../etc/passwd', 'a'.repeat(44)]) {
      assert.equal(code(await r.exchange(bad, token)), ErrorCode.AUTH_CHALLENGE_INVALID, bad);
    }

    r.clock.t += 10 * 60 * 1000; // everything above has expired and is swept on the next create
    for (let i = 0; i < 4; i++) await r.challenge();
    const capped = await r.server.request('POST', '/auth/login-challenge', {}, {}, { skipAuth: true });
    assert.equal(capped.status, 429);
    assert.equal(code(capped), ErrorCode.AUTH_RATE_LIMITED);
  } finally {
    await r.stop();
  }
});

test('rate limits apply per client to challenge creation, exchange and refresh', async () => {
  const mk = (max: number): ReturnType<typeof createRateLimiter> => createRateLimiter({ windowMs: 60_000, max });
  const r = await rig({ limits: { challenge: mk(3), exchange: mk(2), refresh: mk(2) } });
  try {
    for (let i = 0; i < 3; i++)
      assert.equal((await r.server.request('POST', '/auth/login-challenge', {}, {}, { skipAuth: true })).status, 201);
    const limited = await r.server.request('POST', '/auth/login-challenge', {}, {}, { skipAuth: true });
    assert.equal(limited.status, 429);
    for (let i = 0; i < 2; i++) assert.equal((await r.exchange('x'.repeat(43), 'a.b.c')).status, 401);
    assert.equal((await r.exchange('x'.repeat(43), 'a.b.c')).status, 429);
    for (let i = 0; i < 2; i++) assert.equal((await r.refresh(`xoar_${'x'.repeat(43)}`)).status, 401);
    assert.equal((await r.refresh(`xoar_${'x'.repeat(43)}`)).status, 429);
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------- sessions

test('access credentials expire after 15 minutes; refresh rotates; reuse of a used refresh credential revokes the whole session', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const s1 = await r.login('g-alice');
    assert.equal((await r.call('GET', '/workspaces', s1.access)).status, 200);

    r.clock.t += 15 * 60 * 1000 + 1000;
    const expired = await r.call('GET', '/workspaces', s1.access);
    assert.equal(expired.status, 401);
    assert.equal(code(expired), ErrorCode.AUTH_TOKEN_EXPIRED);

    const rotated = await r.refresh(s1.refresh);
    assert.equal(rotated.status, 200);
    const s2 = rotated.json<{ accessCredential: string; refreshCredential: string }>();
    assert.notEqual(s2.refreshCredential, s1.refresh);
    assert.equal((await r.call('GET', '/workspaces', s2.accessCredential)).status, 200, 'new access works');

    // Replaying the used refresh credential: refused, and the family (including the NEW credentials) is revoked.
    const replay = await r.refresh(s1.refresh);
    assert.equal(replay.status, 401);
    assert.equal(code(replay), ErrorCode.AUTH_TOKEN_INVALID);
    assert.equal((await r.call('GET', '/workspaces', s2.accessCredential)).status, 401, 'family revoked');
    assert.equal((await r.refresh(s2.refreshCredential)).status, 401, 'new refresh credential is dead too');
  } finally {
    await r.stop();
  }
});

test('concurrent refreshes with one credential: at most one wins, and the family does not survive the race', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const s = await r.login('g-alice');
    const results = await Promise.all(Array.from({ length: 6 }, () => r.refresh(s.refresh)));
    assert.ok(results.filter((x) => x.status === 200).length <= 1);
    assert.ok(results.filter((x) => x.status !== 200).every((x) => x.status === 401));
    assert.equal((await r.call('GET', '/workspaces', s.access)).status, 401, 'the racing client loses its session (documented)');
  } finally {
    await r.stop();
  }
});

test('refresh credentials expire (30 days) and a refresh credential never authenticates an API call', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const s = await r.login('g-alice');
    const asBearer = await r.call('GET', '/workspaces', s.refresh);
    assert.equal(asBearer.status, 401);
    assert.equal(code(asBearer), ErrorCode.AUTH_KEY_INVALID);
    r.clock.t += 30 * 24 * 60 * 60 * 1000 + 1000;
    const res = await r.refresh(s.refresh);
    assert.equal(res.status, 401);
    assert.equal(code(res), ErrorCode.AUTH_TOKEN_EXPIRED);
  } finally {
    await r.stop();
  }
});

test('logout revokes exactly the calling session; other sessions of the same user are untouched; non-session credentials cannot log out', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const a = await r.login('g-alice');
    const b = await r.login('g-alice');
    const out = await r.call('POST', '/auth/logout', a.access, {});
    assert.equal(out.status, 204);
    assert.equal((await r.call('GET', '/workspaces', a.access)).status, 401);
    assert.equal((await r.refresh(a.refresh)).status, 401);
    assert.equal((await r.call('GET', '/workspaces', b.access)).status, 200, 'the other session is untouched');
    assert.equal((await r.call('POST', '/auth/logout', a.access, {})).status, 401, 'logout needs a live session');
    assert.equal((await r.server.request('POST', '/auth/logout', {}, {}, { skipAuth: true })).status, 401, 'and some credential');
    const withKey = await r.server.request('POST', '/auth/logout', {});
    assert.equal(withKey.status, 400, 'an API key has no session to end');
  } finally {
    await r.stop();
  }
});

test('revoking the identity binding ends every session at once, at request time and at refresh, and re-binding does not revive them', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const a = await r.login('g-alice');
    const b = await r.login('g-alice');
    assert.ok((await r.bindings.revoke(r.idp.issuer, 'g-alice')).ok);
    const denied = await r.call('GET', '/workspaces', a.access);
    assert.equal(denied.status, 401);
    assert.equal(code(denied), ErrorCode.AUTH_IDENTITY_UNBOUND);
    const refresh = await r.refresh(b.refresh);
    assert.equal(code(refresh), ErrorCode.AUTH_IDENTITY_UNBOUND);
    await r.bind('g-alice', 'alice');
    assert.equal((await r.call('GET', '/workspaces', a.access)).status, 401, 're-binding does not resurrect an old session');
    assert.equal((await r.login('g-alice')).access.startsWith('xoas_'), true, 'a fresh sign-in works');
  } finally {
    await r.stop();
  }
});

test('sessions persist across a server restart (new process state, same directories)', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const s = await r.login('g-alice');
    await r.rebuild();
    assert.equal((await r.call('GET', '/workspaces', s.access)).status, 200);
    const rotated = await r.refresh(s.refresh);
    assert.equal(rotated.status, 200);
  } finally {
    await r.stop();
  }
});

test('storage: only digests are persisted, files are 0600 and directories 0700, and no credential or ID token is on disk', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const c = await r.challenge();
    const idToken = await r.idToken('g-alice', c.nonce);
    const ex = await r.exchange(c.challengeId, idToken);
    const s = ex.json<{ accessCredential: string; refreshCredential: string }>();
    const secrets = [
      s.accessCredential,
      s.refreshCredential,
      c.challengeId,
      idToken,
      s.accessCredential.slice(5),
      s.refreshCredential.slice(5),
    ];
    const files = await walk(r.sessionsDir);
    assert.ok(files.length >= 4);
    for (const f of files) {
      assert.equal((await stat(f)).mode & 0o777, 0o600, f);
      const text = await readFile(f, 'utf8');
      for (const secret of secrets) assert.ok(!text.includes(secret) && !f.includes(secret), 'a credential is stored in plaintext');
    }
    for (const d of [
      r.sessionsDir,
      join(r.sessionsDir, 'sessions'),
      join(r.sessionsDir, 'sessions', 'access'),
      join(r.sessionsDir, 'challenges', 'pending'),
    ]) {
      assert.equal((await stat(d)).mode & 0o777, 0o700, d);
    }
  } finally {
    await r.stop();
  }
});

test('storage corruption fails closed: corrupt, symlinked or truncated records are invalid sessions, never accepted and never a crash', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const victim = await r.login('g-alice');
    const sessions = join(r.sessionsDir, 'sessions');
    const accessFile = (await readdir(join(sessions, 'access')))[0] as string;
    const accessPath = join(sessions, 'access', accessFile);
    const original = await readFile(accessPath, 'utf8');

    await writeFile(accessPath, '{"familyId":');
    assert.equal(code(await r.call('GET', '/workspaces', victim.access)), ErrorCode.AUTH_TOKEN_INVALID, 'truncated record');
    await writeFile(accessPath, JSON.stringify({ familyId: '../../../etc', expiresAt: new Date(Date.now() + 1e6).toISOString() }));
    assert.equal(code(await r.call('GET', '/workspaces', victim.access)), ErrorCode.AUTH_TOKEN_INVALID, 'path-shaped family id');
    await rm(accessPath);
    await writeFile(join(r.sessionsDir, 'elsewhere.json'), original);
    await symlink(join(r.sessionsDir, 'elsewhere.json'), accessPath);
    assert.equal(code(await r.call('GET', '/workspaces', victim.access)), ErrorCode.AUTH_TOKEN_INVALID, 'symlinked record');
    await rm(accessPath);
    await writeFile(accessPath, original);
    assert.equal((await r.call('GET', '/workspaces', victim.access)).status, 200, 'restored record works again');

    // A crash after the old refresh credential was consumed but before new ones were written: the client must sign in again.
    const fresh = await r.login('g-alice');
    const { createHash } = await import('node:crypto');
    const name = `${createHash('sha256').update(fresh.refresh).digest('hex')}.json`;
    const { rename } = await import('node:fs/promises');
    await rename(join(sessions, 'refresh', name), join(sessions, 'refresh-used', name));
    const afterCrash = await r.refresh(fresh.refresh);
    assert.equal(afterCrash.status, 401);
    assert.equal((await r.login('g-alice')).access.startsWith('xoas_'), true, 'signing in again works');

    // A corrupt family record is an invalid session.
    const famFile = (await readdir(join(sessions, 'families')))[0] as string;
    await writeFile(join(sessions, 'families', famFile), 'not json');
    for (const t of [fresh.access, victim.access]) await r.call('GET', '/workspaces', t); // must not throw
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------- credential separation and leakage

test('credential separation: an ID token or a refresh credential is not an API credential, and API-key and generic OIDC callers are unaffected', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const c = await r.challenge();
    const idToken = await r.idToken('g-alice', c.nonce);
    const asBearer = await r.call('GET', '/workspaces', idToken);
    assert.equal(asBearer.status, 401, 'an ID token is never an API bearer credential');
    assert.equal((await r.server.request('GET', '/workspaces')).status, 200, 'API key still works');
    assert.equal((await r.call('GET', '/workspaces', 'xoas_unknown-credential-that-is-not-43-chars')).status, 401);
    assert.equal(code(await r.call('GET', '/workspaces', `xoas_${'A'.repeat(43)}`)), ErrorCode.AUTH_TOKEN_INVALID);
  } finally {
    await r.stop();
  }
});

test('no credential, ID token, nonce or challenge id appears in any response body, header or log line', async () => {
  const r = await rig();
  try {
    await r.bind('g-alice', 'alice');
    const seen: string[] = [];
    const c = await r.challenge();
    seen.push(c.challengeId, c.nonce);
    const idToken = await r.idToken('g-alice', c.nonce);
    seen.push(idToken);
    const ex = await r.exchange(c.challengeId, idToken);
    const s = ex.json<{ accessCredential: string; refreshCredential: string }>();
    seen.push(s.accessCredential, s.refreshCredential);
    const attempts = [
      await r.exchange(c.challengeId, idToken), // replay
      await r.refresh('xoar_' + 'A'.repeat(43)),
      await r.call('GET', '/workspaces', `xoas_${'B'.repeat(43)}`),
      await r.call('GET', '/workspaces', idToken),
      await r.exchange('z'.repeat(43), idToken),
    ];
    for (const res of attempts) {
      const surface = res.bodyText + JSON.stringify(res.headers);
      for (const secret of seen) assert.ok(!surface.includes(secret), 'a secret appears in an error response');
    }
    const refreshed = await r.refresh(s.refreshCredential);
    seen.push(refreshed.json<{ accessCredential: string }>().accessCredential);
    for (const line of r.logger.lines) for (const secret of seen) assert.ok(!line.includes(secret), 'a secret appears in a log line');
    assert.ok(!r.logger.lines.join('\n').includes('must-not-be-stored@example.com'));
  } finally {
    await r.stop();
  }
});

test('defaultLimits and config: sign-in is off unless configured; half-set or invalid values refuse to start', () => {
  assert.equal(loadSessionAuthConfig({}), undefined);
  assert.equal(loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: '  ' }), undefined);
  for (const name of ['XO_API_GOOGLE_ISSUER', 'XO_API_GOOGLE_JWKS_URI', 'XO_API_SESSIONS_DIR']) {
    assert.throws(() => loadSessionAuthConfig({ [name]: 'https://x.example' }), new RegExp(`${name}.*without XO_API_GOOGLE_CLIENT_ID`));
  }
  for (const bad of ['has space', 'x'.repeat(300), 'a/b', 'a;b'])
    assert.throws(() => loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: bad }), /XO_API_GOOGLE_CLIENT_ID/);
  for (const bad of ['http://accounts.example', 'https://u:p@x.example', 'https://x.example/?q=1', 'not a url']) {
    assert.throws(
      () => loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID, XO_API_GOOGLE_ISSUER: bad }),
      /XO_API_GOOGLE_ISSUER/,
      bad,
    );
  }
  const ok = loadSessionAuthConfig({ XO_API_GOOGLE_CLIENT_ID: CLIENT_ID });
  assert.equal(ok?.issuer, GOOGLE_ISSUER);
  assert.equal(ok?.sessionsDir, '.xo-data/sessions');
  assert.ok(defaultLimits().challenge.allow('k'));
});
