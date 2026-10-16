import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT, generateKeyPair } from 'jose';
import { ErrorCode } from '@xo/errors';
import { TestServer } from './test-helpers.js';
import { AUDIENCE, CapturingLogger, TestIdp } from './oidc-test-idp.js';
import { loadOidcConfig } from '../src/auth/oidc/config.js';
import { createOidcVerifier, type VerifierTuning } from '../src/auth/oidc/verifier.js';
import { FsIdentityBindingStore, computeBindingId } from '../src/auth/oidc/fs-binding-store.js';
import { createAuthMiddleware } from '../src/http/auth.js';
import { buildRouter } from '../src/server.js';
import type { ApiRequest } from '../src/http/types.js';

interface Rig {
  readonly idp: TestIdp;
  readonly server: TestServer;
  readonly bindings: FsIdentityBindingStore;
  readonly logger: CapturingLogger;
  bind(sub: string, identityId: string, extra?: { orgId?: string; kind?: 'human' | 'service' }): Promise<void>;
  get(path: string, token: string, headers?: Record<string, string>): ReturnType<TestServer['request']>;
  stop(): Promise<void>;
}

async function rig(tuning: VerifierTuning = {}): Promise<Rig> {
  const idp = await TestIdp.start();
  const dir = await mkdtemp(join(tmpdir(), 'xo-oidc-bindings-'));
  const bindings = new FsIdentityBindingStore(dir);
  const config = loadOidcConfig({ XO_API_OIDC_ISSUER: idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE, XO_API_OIDC_BINDINGS_DIR: dir });
  assert.ok(config);
  const verifier = createOidcVerifier(config, { jwksCooldownMs: 0, discoveryRetryMs: 0, httpTimeoutMs: 2000, ...tuning });
  const logger = new CapturingLogger();
  const server = await TestServer.start({ oidc: { verifier, bindings }, logger });
  return {
    idp,
    server,
    bindings,
    logger,
    async bind(sub, identityId, extra = {}) {
      const created = await bindings.create({
        bindingId: computeBindingId(idp.issuer, sub),
        issuer: idp.issuer,
        subject: sub,
        identityId,
        principalKind: extra.kind ?? 'human',
        ...(extra.orgId !== undefined ? { orgId: extra.orgId } : {}),
        createdAt: new Date().toISOString(),
      });
      assert.ok(created.ok);
    },
    get: (path, token, headers = {}) =>
      server.request('GET', path, undefined, { authorization: `Bearer ${token}`, ...headers }, { skipAuth: true }),
    async stop() {
      await server.stop();
      await idp.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const code = (res: { json: <T>() => T }): string => res.json<{ error: { code: string } }>().error.code;

// ---------------------------------------------------------------------
// Acceptance and binding
// ---------------------------------------------------------------------

test('a valid access token with an active (iss, sub) binding authenticates', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    const res = await r.get('/registry/search', await r.idp.sign()); // 400 = past auth, into the route
    assert.equal(res.status, 400);
    assert.equal(code(res), ErrorCode.INVALID_ARGUMENT);
  } finally {
    await r.stop();
  }
});

test('a valid token whose subject has no binding is refused (401 AUTH_IDENTITY_UNBOUND) and nothing is provisioned', async () => {
  const r = await rig();
  try {
    const res = await r.get('/registry/search', await r.idp.sign({ sub: 'stranger' }));
    assert.equal(res.status, 401);
    assert.equal(code(res), ErrorCode.AUTH_IDENTITY_UNBOUND);
    const listed = await r.bindings.list();
    assert.ok(listed.ok);
    assert.equal(listed.value.length, 0);
  } finally {
    await r.stop();
  }
});

test('a binding for another subject, or for the same subject at another issuer, does not authorize this token', async () => {
  const r = await rig();
  try {
    await r.bind('someone-else', 'bob');
    const res = await r.get('/registry/search', await r.idp.sign({ sub: 'user-1' }));
    assert.equal(code(res), ErrorCode.AUTH_IDENTITY_UNBOUND);
    const created = await r.bindings.create({
      bindingId: computeBindingId('https://other.example', 'user-1'),
      issuer: 'https://other.example',
      subject: 'user-1',
      identityId: 'mallory',
      principalKind: 'human',
      createdAt: new Date().toISOString(),
    });
    assert.ok(created.ok);
    const again = await r.get('/registry/search', await r.idp.sign({ sub: 'user-1' }));
    assert.equal(code(again), ErrorCode.AUTH_IDENTITY_UNBOUND);
  } finally {
    await r.stop();
  }
});

test('revoking a binding takes effect on the very next request', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    const token = await r.idp.sign();
    assert.equal((await r.get('/registry/search', token)).status, 400);
    const revoked = await r.bindings.revoke(r.idp.issuer, 'user-1');
    assert.ok(revoked.ok);
    const res = await r.get('/registry/search', token);
    assert.equal(res.status, 401);
    assert.equal(code(res), ErrorCode.AUTH_IDENTITY_UNBOUND);
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------

test('invalid tokens are refused with the documented codes', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    const now = Math.floor(Date.now() / 1000);
    const cases: Array<[string, string, string]> = [
      ['wrong issuer', await r.idp.sign({ iss: 'https://evil.example' }), ErrorCode.AUTH_TOKEN_INVALID],
      ['wrong audience', await r.idp.sign({ aud: 'someone-else' }), ErrorCode.AUTH_TOKEN_INVALID],
      ['audience list without ours', await r.idp.sign({ aud: ['a', 'b'] }), ErrorCode.AUTH_TOKEN_INVALID],
      ['expired', await r.idp.sign({ iat: now - 7200, exp: now - 3600 }), ErrorCode.AUTH_TOKEN_EXPIRED],
      ['not yet valid (nbf)', await r.idp.sign({ nbf: now + 3600, exp: now + 7200 }), ErrorCode.AUTH_TOKEN_INVALID],
      ['issued in the future (iat)', await r.idp.sign({ iat: now + 3600, exp: now + 7200 }), ErrorCode.AUTH_TOKEN_INVALID],
      ['missing sub', await r.idp.sign({ sub: undefined }), ErrorCode.AUTH_TOKEN_INVALID],
      ['ID token (nonce)', await r.idp.sign({ claims: { nonce: 'n' } }), ErrorCode.AUTH_TOKEN_INVALID],
      ['ID token (token_use)', await r.idp.sign({ claims: { token_use: 'id' } }), ErrorCode.AUTH_TOKEN_INVALID],
      ['ID token (typ)', await r.idp.sign({ typ: 'id_token' }), ErrorCode.AUTH_TOKEN_INVALID],
      ['garbage', 'aaa.bbb.ccc', ErrorCode.AUTH_TOKEN_INVALID],
      ['two segments', 'aaa.bbb', ErrorCode.AUTH_KEY_INVALID], // not JWT-shaped: takes the API-key path unchanged
    ];
    for (const [name, token, expected] of cases) {
      const res = await r.get('/registry/search', token);
      assert.equal(res.status, 401, name);
      assert.equal(code(res), expected, name);
    }
  } finally {
    await r.stop();
  }
});

test('forged tokens are refused: tampered payload, foreign key, alg none, HS256 keyed with the public JWK, oversize', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    const good = await r.idp.sign();
    const [h, p, s] = good.split('.') as [string, string, string];

    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: 'admin' })).toString(
      'base64url',
    );
    const tampered = `${h}.${forgedPayload}.${s}`;

    const { privateKey } = await generateKeyPair('RS256');
    const foreign = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(r.idp.issuer)
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(privateKey);

    const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = enc({ iss: r.idp.issuer, aud: AUDIENCE, sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 300 });
    const algNone = `${enc({ alg: 'none', typ: 'JWT' })}.${body}.`;
    // Algorithm confusion: HMAC using the (public) key material as the secret.
    const pub = JSON.stringify(r.idp.publicJwk('k1'));
    const { createHmac } = await import('node:crypto');
    const hsHead = enc({ alg: 'HS256', kid: 'k1', typ: 'JWT' });
    const hs256 = `${hsHead}.${body}.${createHmac('sha256', pub).update(`${hsHead}.${body}`).digest('base64url')}`;
    const huge = `${h}.${Buffer.from('x'.repeat(10_000)).toString('base64url')}.${s}`;

    for (const [name, token] of [
      ['tampered', tampered],
      ['foreign key', foreign],
      ['alg none', algNone],
      ['HS256 confusion', hs256],
      ['oversize', huge],
    ] as const) {
      const res = await r.get('/registry/search', token);
      assert.equal(res.status, 401, name);
      assert.equal(code(res), ErrorCode.AUTH_TOKEN_INVALID, name);
    }
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------------
// Keys: unknown kid, rotation, outage
// ---------------------------------------------------------------------

test('unknown kid is refused; a rotated-in key is accepted after the key set is refetched', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    assert.equal((await r.get('/registry/search', await r.idp.sign())).status, 400); // warms the cache
    const stray = (await generateKeyPair('RS256')).privateKey;
    const unpublished = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k-unknown' })
      .setIssuer(r.idp.issuer)
      .setAudience(AUDIENCE)
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(stray);
    const bad = await r.get('/registry/search', unpublished);
    assert.equal(code(bad), ErrorCode.AUTH_TOKEN_INVALID);

    await r.idp.addKey('k3'); // rotation: IdP now publishes k3
    const ok = await r.get('/registry/search', await r.idp.sign({ kid: 'k3' }));
    assert.equal(ok.status, 400, 'rotated key accepted');
    assert.equal((await r.get('/registry/search', await r.idp.sign({ kid: 'k1' }))).status, 400, 'old key still published, still accepted');
  } finally {
    await r.stop();
  }
});

test('unknown-kid refetches are bounded by the cooldown (no amplification)', async () => {
  const r = await rig({ jwksCooldownMs: 60_000 });
  try {
    await r.bind('user-1', 'alice');
    await r.get('/registry/search', await r.idp.sign());
    const before = r.idp.jwksHits;
    const stray = (await generateKeyPair('RS256')).privateKey;
    for (let i = 0; i < 5; i++) {
      const t = await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', kid: `rand-${i}` })
        .setIssuer(r.idp.issuer)
        .setAudience(AUDIENCE)
        .setSubject('user-1')
        .setExpirationTime('5m')
        .sign(stray);
      assert.equal(code(await r.get('/registry/search', t)), ErrorCode.AUTH_TOKEN_INVALID);
    }
    assert.equal(r.idp.jwksHits, before, 'no extra JWKS fetches inside the cooldown');
  } finally {
    await r.stop();
  }
});

test('JWKS outage fails closed with 503 AUTH_PROVIDER_UNAVAILABLE, never an authentication bypass, and recovers', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    r.idp.jwksStatus = 500;
    const down = await r.get('/registry/search', await r.idp.sign());
    assert.equal(down.status, 503);
    assert.equal(code(down), ErrorCode.AUTH_PROVIDER_UNAVAILABLE);
    r.idp.jwksStatus = 200;
    assert.equal((await r.get('/registry/search', await r.idp.sign())).status, 400, 'recovers when the provider returns');
  } finally {
    await r.stop();
  }
});

test('discovery outage and issuer-mismatched discovery both fail closed', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    r.idp.discoveryStatus = 500;
    const down = await r.get('/registry/search', await r.idp.sign());
    assert.equal(down.status, 503);
    assert.equal(code(down), ErrorCode.AUTH_PROVIDER_UNAVAILABLE);
  } finally {
    await r.stop();
  }

  // A discovery document that names a different issuer is not trusted.
  const idp = await TestIdp.start();
  const realIssuer = idp.issuer;
  idp.issuer = 'https://not-the-configured-issuer.example';
  const config = loadOidcConfig({ XO_API_OIDC_ISSUER: realIssuer, XO_API_OIDC_AUDIENCE: AUDIENCE });
  assert.ok(config);
  const verifier = createOidcVerifier(config, { discoveryRetryMs: 0 });
  idp.issuer = realIssuer; // sign with the configured issuer, discovery still lies
  const lying = await idp.sign();
  idp.issuer = 'https://not-the-configured-issuer.example';
  await assert.rejects(verifier.verify(lying), (e: { code?: string }) => e.code === ErrorCode.AUTH_PROVIDER_UNAVAILABLE);
  await idp.stop();
});

// ---------------------------------------------------------------------
// Principal binding: nothing from the request or token chooses the principal
// ---------------------------------------------------------------------

function fakeReq(token: string, extra: Partial<ApiRequest> = {}): ApiRequest {
  return {
    method: 'GET',
    path: '/x',
    headers: { authorization: `Bearer ${token}` },
    query: new URLSearchParams(),
    params: {},
    ...extra,
  } as unknown as ApiRequest;
}

test('principal comes from the binding only: spoofed claims, headers and query cannot change id, org, kind or permissions', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice', { orgId: 'org-real' });
    const verifier = createOidcVerifier(loadOidcConfig({ XO_API_OIDC_ISSUER: r.idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE })!, {
      jwksCooldownMs: 0,
    });
    const mw = createAuthMiddleware({ apiKeyStore: r.server.apiKeyStore, oidc: { verifier, bindings: r.bindings } });
    const token = await r.idp.sign({
      claims: {
        orgId: 'org-evil',
        org_id: 'org-evil',
        role: 'admin',
        roles: ['admin'],
        permissions: ['*'],
        scope: 'xo:admin',
        principal: { kind: 'service', id: 'root' },
        identityId: 'root',
        email: 'root@example.com',
      },
    });
    const req = fakeReq(token, {
      headers: { authorization: `Bearer ${token}`, 'x-xo-principal': 'root', 'x-org-id': 'org-evil', 'x-identity-id': 'root' },
      query: new URLSearchParams('principal=root&orgId=org-evil'),
    });
    let reached = false;
    await mw(req, async () => {
      reached = true;
      return { status: 200, body: {} };
    });
    assert.ok(reached);
    assert.deepEqual(
      { kind: req.principal?.kind, id: req.principal?.id, orgId: req.principal?.orgId },
      { kind: 'human', id: 'alice', orgId: 'org-real' },
    );
    assert.equal(req.identity?.identityId, 'alice');
    assert.deepEqual(req.authentication, { credential: 'oidc', issuer: r.idp.issuer });
  } finally {
    await r.stop();
  }
});

test('request-body identity fields are inert for OIDC callers: a workspace is owned by the bound principal', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    await r.bind('user-2', 'bob');
    const aliceTok = await r.idp.sign({ sub: 'user-1' });
    const bobTok = await r.idp.sign({ sub: 'user-2' });
    const created = await r.server.request(
      'POST',
      '/workspaces',
      { name: 'a', identityId: 'bob', principal: { kind: 'service', id: 'bob' } },
      { authorization: `Bearer ${aliceTok}` },
      { skipAuth: true },
    );
    assert.equal(created.status, 201);
    const id = created.json<{ workspaceId?: string; id?: string }>().workspaceId ?? created.json<{ id?: string }>().id;
    assert.ok(id);
    // Alice sees it; Bob (authenticated, bound, but not the owner) does not.
    assert.equal((await r.get(`/workspaces/${id}`, aliceTok)).status, 200);
    const bobView = await r.get(`/workspaces/${id}`, bobTok);
    assert.equal(bobView.status, 404);
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------------
// API keys: separate, unchanged
// ---------------------------------------------------------------------

test('API keys keep working and are never offered to the JWT verifier; JWTs are never looked up as keys', async () => {
  const r = await rig();
  try {
    let verifierCalls = 0;
    const real = createOidcVerifier(loadOidcConfig({ XO_API_OIDC_ISSUER: r.idp.issuer, XO_API_OIDC_AUDIENCE: AUDIENCE })!);
    const counting = { verify: (t: string) => (verifierCalls++, real.verify(t)) };
    const mw = createAuthMiddleware({ apiKeyStore: r.server.apiKeyStore, oidc: { verifier: counting, bindings: r.bindings } });

    const keyReq = fakeReq(r.server.apiKey);
    await mw(keyReq, async () => ({ status: 200, body: {} }));
    assert.equal(keyReq.principal?.id, r.server.identityId);
    assert.deepEqual(keyReq.authentication, { credential: 'api-key' });
    assert.equal(verifierCalls, 0);

    // xoak_-prefixed but JWT-shaped: still an API key lookup, still refused as an unknown key.
    await assert.rejects(
      mw(fakeReq('xoak_aaa.bbb.ccc'), async () => ({ status: 200, body: {} })),
      (e: { code?: string }) => e.code === ErrorCode.AUTH_KEY_INVALID,
    );
    assert.equal(verifierCalls, 0);

    // Via HTTP too.
    const http1 = await r.server.request('GET', '/registry/search');
    assert.equal(http1.status, 400);
  } finally {
    await r.stop();
  }
});

test('with OIDC not configured a JWT gets the unchanged API-key answer', async () => {
  const server = await TestServer.start();
  try {
    const idp = await TestIdp.start();
    const res = await server.request(
      'GET',
      '/registry/search',
      undefined,
      { authorization: `Bearer ${await idp.sign()}` },
      { skipAuth: true },
    );
    assert.equal(res.status, 401);
    assert.equal(code(res), ErrorCode.AUTH_KEY_INVALID);
    await idp.stop();
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------------
// Ordering, replay, leakage
// ---------------------------------------------------------------------

test('authentication happens before protected execution, and again on an idempotent replay', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    const token = await r.idp.sign();
    const path = '/workspaces/ws-x/workflows/wf-x/executions';
    const headers = { 'idempotency-key': 'replay-key-1', 'content-type': 'application/json' };
    // Bound caller reaches the handler (which then answers about the unknown workspace — not 401).
    const first = await r.server.request(
      'POST',
      path,
      { compilationId: 'c', input: {} },
      { authorization: `Bearer ${token}`, ...headers },
      { skipAuth: true },
    );
    assert.notEqual(first.status, 401);
    // After revocation, the same request with the same key is refused at authentication, not replayed.
    await r.bindings.revoke(r.idp.issuer, 'user-1');
    const replay = await r.server.request(
      'POST',
      path,
      { compilationId: 'c', input: {} },
      { authorization: `Bearer ${token}`, ...headers },
      { skipAuth: true },
    );
    assert.equal(replay.status, 401);
    assert.equal(code(replay), ErrorCode.AUTH_IDENTITY_UNBOUND);
    // Never authenticated at all.
    const anon = await r.server.request('POST', path, { compilationId: 'c', input: {} }, headers, { skipAuth: true });
    assert.equal(anon.status, 401);
  } finally {
    await r.stop();
  }
});

test('neither error bodies nor logs contain the bearer token or its claims', async () => {
  const r = await rig();
  try {
    const now = Math.floor(Date.now() / 1000);
    const secretish = 'claim-value-that-must-not-leak';
    const tokens = [
      await r.idp.sign({ sub: 'stranger', claims: { email: secretish } }), // unbound
      await r.idp.sign({ iat: now - 7200, exp: now - 3600, claims: { email: secretish } }), // expired
      await r.idp.sign({ aud: 'nope', claims: { email: secretish } }), // wrong audience
    ];
    for (const token of tokens) {
      const res = await r.get('/registry/search', token);
      assert.equal(res.status, 401);
      assert.ok(!res.bodyText.includes(token) && !res.bodyText.includes(secretish) && !res.bodyText.includes('stranger'));
      assert.ok(!res.bodyText.includes(r.idp.issuer), 'no issuer/validation internals in the response');
      for (const line of r.logger.lines)
        assert.ok(!line.includes(token) && !line.includes(secretish), 'log line leaked credential material');
    }
  } finally {
    await r.stop();
  }
});

// ---------------------------------------------------------------------
// Configuration fails closed
// ---------------------------------------------------------------------

test('configuration: off when unset; half-set, malformed or insecure values throw', () => {
  assert.equal(loadOidcConfig({}), undefined);
  assert.equal(loadOidcConfig({ XO_API_OIDC_ISSUER: '  ', XO_API_OIDC_AUDIENCE: '' }), undefined);
  assert.throws(() => loadOidcConfig({ XO_API_OIDC_ISSUER: 'https://idp.example' }), /XO_API_OIDC_AUDIENCE is missing/);
  assert.throws(() => loadOidcConfig({ XO_API_OIDC_AUDIENCE: 'api' }), /XO_API_OIDC_ISSUER is missing/);
  assert.throws(() => loadOidcConfig({ XO_API_OIDC_JWKS_URI: 'https://idp.example/jwks' }), /without/);
  const base = { XO_API_OIDC_AUDIENCE: 'api' };
  for (const bad of [
    'not a url',
    'http://idp.example',
    'https://u:p@idp.example',
    'https://idp.example/?q=1',
    'https://idp.example/#f',
    'ftp://idp.example',
  ]) {
    assert.throws(() => loadOidcConfig({ ...base, XO_API_OIDC_ISSUER: bad }), /XO_API_OIDC_ISSUER/, bad);
  }
  assert.throws(
    () => loadOidcConfig({ ...base, XO_API_OIDC_ISSUER: 'https://idp.example', XO_API_OIDC_JWKS_URI: 'http://idp.example/jwks' }),
    /XO_API_OIDC_JWKS_URI/,
  );
  assert.throws(
    () => loadOidcConfig({ XO_API_OIDC_ISSUER: 'https://idp.example', XO_API_OIDC_AUDIENCE: 'has space' }),
    /XO_API_OIDC_AUDIENCE/,
  );
  assert.throws(
    () => loadOidcConfig({ ...base, XO_API_OIDC_ISSUER: 'https://idp.example', XO_API_OIDC_CLOCK_SKEW_SECONDS: '9999' }),
    /SKEW/,
  );
  const ok = loadOidcConfig({ ...base, XO_API_OIDC_ISSUER: 'https://idp.example', XO_API_OIDC_CLOCK_SKEW_SECONDS: '10' });
  assert.equal(ok?.clockSkewSeconds, 10);
  assert.equal(loadOidcConfig({ ...base, XO_API_OIDC_ISSUER: 'http://127.0.0.1:9999' })?.issuer, 'http://127.0.0.1:9999');
  // The error names the variable and rule, never the supplied value.
  try {
    loadOidcConfig({ ...base, XO_API_OIDC_ISSUER: 'https://u:topsecret@idp.example' });
    assert.fail('should throw');
  } catch (e) {
    assert.ok(!(e as Error).message.includes('topsecret'));
  }
});

test('server construction fails visibly on invalid OIDC environment instead of starting with weaker auth', () => {
  assert.throws(() => buildRouter({ env: { XO_API_OIDC_ISSUER: 'https://idp.example' } }), /XO_API_OIDC_AUDIENCE is missing/);
  assert.doesNotThrow(() => buildRouter({ env: {} }));
});

// ---------------------------------------------------------------------
// Hardening review: algorithms, key types, provider misbehaviour
// ---------------------------------------------------------------------

test('ES256 and PS256 access tokens are accepted alongside RS256; a token cannot name a key of the wrong type', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    await r.idp.addKey('ec1', 'ES256');
    await r.idp.addKey('ps1', 'PS256');
    assert.equal((await r.get('/registry/search', await r.idp.sign({ kid: 'ec1' }))).status, 400, 'ES256');
    assert.equal((await r.get('/registry/search', await r.idp.sign({ kid: 'ps1' }))).status, 400, 'PS256');
    // Key-type confusion: the signature is made with an RSA key but the header names the EC key's kid (and vice versa).
    const rsaNamesEc = await r.idp.sign({ kid: 'k1', headerKid: 'ec1' });
    const ecNamesRsa = await r.idp.sign({ kid: 'ec1', headerKid: 'k1' });
    for (const token of [rsaNamesEc, ecNamesRsa]) {
      const res = await r.get('/registry/search', token);
      assert.equal(res.status, 401);
      assert.equal(code(res), ErrorCode.AUTH_TOKEN_INVALID);
    }
  } finally {
    await r.stop();
  }
});

test('a key that signs before the provider publishes it is refused, then accepted once published', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    await r.idp.addKey('k-new', 'RS256', false);
    const token = await r.idp.sign({ kid: 'k-new' });
    assert.equal(code(await r.get('/registry/search', token)), ErrorCode.AUTH_TOKEN_INVALID);
    r.idp.publish('k-new');
    assert.equal((await r.get('/registry/search', token)).status, 400);
  } finally {
    await r.stop();
  }
});

test('redirects from discovery or the JWKS endpoint are never followed (503), even to a valid key set', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    r.idp.jwksRedirect = true;
    const viaJwks = await r.get('/registry/search', await r.idp.sign());
    assert.equal(viaJwks.status, 503);
    assert.equal(code(viaJwks), ErrorCode.AUTH_PROVIDER_UNAVAILABLE);
  } finally {
    await r.stop();
  }
  const r2 = await rig();
  try {
    await r2.bind('user-1', 'alice');
    r2.idp.discoveryRedirect = true;
    const viaDiscovery = await r2.get('/registry/search', await r2.idp.sign());
    assert.equal(viaDiscovery.status, 503);
    assert.equal(code(viaDiscovery), ErrorCode.AUTH_PROVIDER_UNAVAILABLE);
  } finally {
    await r2.stop();
  }
});

test('malformed JWKS responses are a provider fault (503); an empty key set is simply no matching key (401)', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    for (const body of ['not json at all', '{"keys":"nope"}', '[]']) {
      r.idp.jwksBody = body;
      const res = await r.get('/registry/search', await r.idp.sign());
      assert.equal(res.status, 503, body);
      assert.equal(code(res), ErrorCode.AUTH_PROVIDER_UNAVAILABLE, body);
    }
    for (const body of ['{"keys":[]}', '{"keys":[{"kty":"RSA"}]}']) {
      r.idp.jwksBody = body;
      const none = await r.get('/registry/search', await r.idp.sign());
      assert.equal(none.status, 401, body);
      assert.equal(code(none), ErrorCode.AUTH_TOKEN_INVALID, body);
    }
    r.idp.jwksBody = undefined;
    assert.equal((await r.get('/registry/search', await r.idp.sign())).status, 400, 'recovers');
  } finally {
    await r.stop();
  }
});

test('a provider outage after the key set is cached keeps verifying cached keys, never accepts unknown ones, and discovery loss does not strand a working key set', async () => {
  const r = await rig({ discoveryTtlMs: 0, discoveryRetryMs: 0 });
  try {
    await r.bind('user-1', 'alice');
    assert.equal((await r.get('/registry/search', await r.idp.sign())).status, 400);
    const hitsBefore = r.idp.discoveryHits;
    r.idp.discoveryStatus = 500; // discovery now fails on every request
    assert.equal((await r.get('/registry/search', await r.idp.sign())).status, 400, 'cached key location still used');
    assert.ok(r.idp.discoveryHits > hitsBefore, 'discovery really was retried');
    // A key the provider has not published still cannot authenticate, outage or not.
    await r.idp.addKey('k-late', 'RS256', false);
    r.idp.jwksStatus = 500;
    const res = await r.get('/registry/search', await r.idp.sign({ kid: 'k-late' }));
    assert.equal(res.status, 503);
  } finally {
    await r.stop();
  }
});

test('credentials in the wrong shape never authenticate and never reach the JWT verifier', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    const good = await r.idp.sign();
    const send = (authorization: string | undefined): ReturnType<TestServer['request']> =>
      r.server.request('GET', '/registry/search', undefined, authorization === undefined ? {} : { authorization }, { skipAuth: true });
    const cases: Array<[string, string | undefined, string]> = [
      ['no header', undefined, ErrorCode.AUTH_KEY_MISSING],
      ['Basic scheme', `Basic ${Buffer.from('a:b').toString('base64')}`, ErrorCode.AUTH_KEY_MISSING],
      ['Token scheme with a valid JWT', `Token ${good}`, ErrorCode.AUTH_KEY_MISSING],
      ['bare JWT with no scheme', good, ErrorCode.AUTH_KEY_MISSING],
      ['empty bearer', 'Bearer ', ErrorCode.AUTH_KEY_MISSING],
      ['unknown API key', 'Bearer xoak_doesnotexist', ErrorCode.AUTH_KEY_INVALID],
      ['opaque non-JWT token', 'Bearer opaque-access-token', ErrorCode.AUTH_KEY_INVALID],
    ];
    for (const [name, header, expected] of cases) {
      const res = await send(header);
      assert.equal(res.status, 401, name);
      assert.equal(code(res), expected, name);
    }
    // The scheme word is matched exactly ("Bearer"), as it always has been for API keys; a lowercase
    // scheme is refused rather than guessed at (fails closed; RFC 7235 would allow it, which is a
    // pre-existing, deliberately unchanged strictness).
    assert.equal(code(await send(`bearer ${good}`)), ErrorCode.AUTH_KEY_MISSING);
    // The same JWT in a query string is not a credential.
    const q = await r.server.request('GET', `/registry/search?access_token=${good}`, undefined, {}, { skipAuth: true });
    assert.equal(q.status, 401);
  } finally {
    await r.stop();
  }
});

test('an oversized discovery document is refused (503) without being read to the end, even when no length is declared', async () => {
  const r = await rig();
  try {
    await r.bind('user-1', 'alice');
    const pad = 'x'.repeat(200_000);
    r.idp.discoveryBody = JSON.stringify({ issuer: r.idp.issuer, jwks_uri: `${r.idp.issuer}/jwks`, pad });
    const res = await r.get('/registry/search', await r.idp.sign());
    assert.equal(res.status, 503);
    assert.equal(code(res), ErrorCode.AUTH_PROVIDER_UNAVAILABLE);
    r.idp.discoveryBody = undefined;
    assert.equal((await r.get('/registry/search', await r.idp.sign())).status, 400, 'a normal document works');
  } finally {
    await r.stop();
  }
});
