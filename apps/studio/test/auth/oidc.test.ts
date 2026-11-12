import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationUrl,
  createPkce,
  discoverProvider,
  exchangeCodeForIdentity,
  refusalDetail,
  parseCallback,
  parseOidcConfig,
  validateRedirectUri,
  type OidcConfig,
} from '../../src/auth/oidc';
import { decodeCredential, encodeCredential } from '../../src/auth/envelope';
import { resolveAuthConfig } from '../../src/shell/config';
import { FakeIdp } from '../fakeIdp';

const cfg: OidcConfig = { issuer: 'https://idp.test', clientId: 'studio', scopes: ['openid', 'offline_access'] };
const crypto = webcrypto as unknown as Crypto;

describe('parseOidcConfig', () => {
  it('accepts a minimal valid config and defaults scopes', () => {
    const r = parseOidcConfig({ issuer: 'https://idp.test', clientId: 'studio' });
    expect(r.ok && r.value.scopes).toEqual(['openid', 'offline_access']);
  });
  it.each([
    [{ issuer: 'http://idp.test', clientId: 'a' }, /https/],
    [{ issuer: 'https://u:p@idp.test', clientId: 'a' }, /https/],
    [{ issuer: 'https://idp.test?x=1', clientId: 'a' }, /query/],
    [{ issuer: 'javascript:alert(1)', clientId: 'a' }, /https/],
    [{ issuer: 'https://idp.test' }, /clientId/],
    [{ issuer: 'https://idp.test', clientId: 'a b' }, /clientId/],
    [{ issuer: 'https://idp.test', clientId: 'a', clientSecret: 'x' }, /secret/],
    [{ issuer: 'https://idp.test', clientId: 'a', client_secret: 'x' }, /secret/],
    [{ issuer: 'https://idp.test', clientId: 'a', scopes: ['profile'] }, /openid/],
    [{ issuer: 'https://idp.test', clientId: 'a', surprise: 1 }, /Unknown/],
    ['nope', /object/],
  ])('rejects %j', (raw, msg) => {
    const r = parseOidcConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.message).toMatch(msg);
  });
  it('allows a loopback http issuer (local dev IdP) but not a LAN host', () => {
    expect(parseOidcConfig({ issuer: 'http://127.0.0.1:8081/realms/x', clientId: 'a' }).ok).toBe(true);
    expect(parseOidcConfig({ issuer: 'http://192.168.1.5/x', clientId: 'a' }).ok).toBe(false);
  });
});

describe('resolveAuthConfig (startup)', () => {
  it('defaults to dev sign-in only', () => expect(resolveAuthConfig(undefined)).toEqual({ ok: true, devSignIn: true }));
  it('fails visibly on invalid oidc settings', () => {
    const r = resolveAuthConfig({ oidc: { issuer: 'ftp://x', clientId: 'a' } });
    expect(r.ok).toBe(false);
  });
  it('fails when dev sign-in is off and no oidc is configured (no way in)', () => {
    expect(resolveAuthConfig({ devSignIn: false }).ok).toBe(false);
  });
  it('rejects a non-boolean devSignIn', () => expect(resolveAuthConfig({ devSignIn: 'no' }).ok).toBe(false));
});

describe('discoverProvider: issuer and endpoint trust', () => {
  it('accepts a matching issuer with secure endpoints', async () => {
    const r = await discoverProvider(cfg, new FakeIdp().fetch);
    expect(r.ok).toBe(true);
  });
  it('REJECTS a provider claiming a different issuer (mix-up defence)', async () => {
    const idp = new FakeIdp();
    idp.discoveryIssuer = 'https://evil.test';
    const r = await discoverProvider(cfg, idp.fetch);
    expect(!r.ok && r.failure.kind).toBe('discovery');
  });
  it('rejects an issuer differing only by trailing slash (exact comparison)', async () => {
    const idp = new FakeIdp();
    idp.discoveryIssuer = 'https://idp.test/';
    expect((await discoverProvider(cfg, idp.fetch)).ok).toBe(false);
  });
  it('rejects non-https endpoints', async () => {
    const idp = new FakeIdp();
    idp.discoveryExtra = { token_endpoint: 'http://idp.test/token' };
    expect((await discoverProvider(cfg, idp.fetch)).ok).toBe(false);
  });
  it('rejects a provider without S256 PKCE', async () => {
    const idp = new FakeIdp();
    idp.discoveryExtra = { code_challenge_methods_supported: ['plain'] };
    const r = await discoverProvider(cfg, idp.fetch);
    expect(!r.ok && r.failure.message).toMatch(/PKCE/);
  });
  it('treats an unreachable provider as transient, not as a bad configuration', async () => {
    const r = await discoverProvider(cfg, async () => {
      throw new TypeError('x');
    });
    expect(!r.ok && r.failure.kind).toBe('network');
  });
});

describe('PKCE, state and callback handling', () => {
  it('generates RFC 7636-shaped verifier, S256 challenge, unique state', async () => {
    const a = await createPkce(crypto);
    const b = await createPkce(crypto);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(a.verifier))).toString('base64url');
    expect(a.challenge).toBe(expected);
    expect(new Set([a.verifier, b.verifier, a.state, b.state]).size).toBe(4);
  });
  it('builds an authorization URL with S256 and state, no secret, and no nonce (Studio never reads the ID token; a nonce can end up in provider access tokens, which the API refuses)', async () => {
    const p = await createPkce(crypto);
    const u = new URL(
      buildAuthorizationUrl(
        { authorizationEndpoint: 'https://idp.test/authorize', tokenEndpoint: 'https://idp.test/token' },
        cfg,
        'http://127.0.0.1:5000/callback',
        p,
      ),
    );
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe(p.state);
    expect(u.searchParams.has('nonce')).toBe(false);
    expect(u.toString()).not.toMatch(/secret|verifier/i);
  });
  it('accepts a callback only with the matching state', () => {
    expect(parseCallback('code=abc&state=S', 'S')).toEqual({ ok: true, value: { code: 'abc' } });
    const bad = parseCallback('code=abc&state=X', 'S');
    expect(!bad.ok && bad.failure.kind).toBe('state_mismatch');
    expect(parseCallback('code=abc', 'S').ok).toBe(false);
  });
  it.each(['access_token=zzz&state=S', 'id_token=zzz&code=a&state=S', 'token=zzz&state=S'])('refuses token-shaped callback %s', (q) => {
    const r = parseCallback(q, 'S');
    expect(!r.ok && r.failure.kind).toBe('malformed');
  });
  it('reports a provider error without echoing provider free text', () => {
    const r = parseCallback('error=access_denied&error_description=%3Cscript%3E&state=S', 'S');
    expect(!r.ok && r.failure.message).toBe('Sign-in was declined.');
    const odd = parseCallback('error=%3Cscript%3E&state=S', 'S');
    expect(!odd.ok && odd.failure.message).not.toMatch(/script/);
  });
  it('does not honour an error response for a different attempt', () => {
    expect(parseCallback('error=access_denied&state=other', 'S').ok).toBe(false);
  });
  it('validates the redirect URI: loopback http or https only', () => {
    expect(validateRedirectUri('http://127.0.0.1:49152/callback').ok).toBe(true);
    for (const bad of ['http://evil.test/cb', 'javascript:1', 'xo://cb', 'http://127.0.0.1/cb?x=1'])
      expect(validateRedirectUri(bad).ok).toBe(false);
  });
});

describe('stored credential envelope', () => {
  it('round-trips both kinds', () => {
    const d = { kind: 'dev-key', key: 'xoak_1' } as const;
    const o = { kind: 'oidc-refresh', refreshToken: 'rt', issuer: 'https://idp.test', clientId: 'studio' } as const;
    expect(decodeCredential(encodeCredential(d))).toEqual(d);
    expect(decodeCredential(encodeCredential(o))).toEqual(o);
  });
  it('treats a bare earlier-format key as a dev key and anything odd as no credential', () => {
    expect(decodeCredential('xoak_abc')).toEqual({ kind: 'dev-key', key: 'xoak_abc' });
    for (const bad of [
      'garbage',
      '{"v":2,"kind":"dev-key","key":"x"}',
      '{"v":1,"kind":"oidc-refresh","refreshToken":"x"}',
      '{"v":1,"kind":"other"}',
      'null',
      '[]',
    ]) {
      expect(decodeCredential(bad)).toBeNull();
    }
  });
});

describe('token-endpoint refusals name the error code the provider gave', () => {
  const endpoints = { authorizationEndpoint: 'https://idp.test/a', tokenEndpoint: 'https://idp.test/t' };
  const args = { code: 'c', verifier: 'v'.repeat(43), redirectUri: 'http://127.0.0.1:5555/callback' };
  const refuse = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('shows a well-formed error code and short description', async () => {
    const r = await exchangeCodeForIdentity(
      endpoints,
      cfg,
      args,
      refuse(400, { error: 'invalid_request', error_description: 'client_secret is missing.' }),
    );
    expect(!r.ok && r.failure.kind).toBe('provider_error');
    expect(!r.ok && r.failure.message).toBe('The identity provider refused the request (invalid_request: client_secret is missing.).');
  });
  it('keeps the plain message when the response has no usable error code', async () => {
    const r = await exchangeCodeForIdentity(endpoints, cfg, args, refuse(400, { message: 'nope' }));
    expect(!r.ok && r.failure.message).toBe('The identity provider refused the request.');
  });
  it('never echoes a malformed code, control characters or an overlong description', () => {
    expect(refusalDetail({ error: 'Bad Code <script>' })).toBe('');
    expect(refusalDetail({ error: 'invalid_client', error_description: 'x\u0000y\n' + 'z'.repeat(500) })).toMatch(
      /^ \(invalid_client: x y z{1,}\)$/,
    );
    expect(refusalDetail({ error: 'invalid_client', error_description: 'x\u0000y\n' + 'z'.repeat(500) }).length).toBeLessThan(160);
  });
  it('still reports invalid_grant as an ended sign-in, not a refusal', async () => {
    const r = await exchangeCodeForIdentity(endpoints, cfg, args, refuse(400, { error: 'invalid_grant' }));
    expect(!r.ok && r.failure.kind).toBe('invalid_grant');
  });
});
