import { webcrypto } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { OidcSession, restoreFromRefreshToken, signInWithSystemBrowser, type SystemBrowserLogin } from '../../src/auth/oidcSession';
import { discoverProvider, type OidcConfig } from '../../src/auth/oidc';
import { FakeIdp } from '../fakeIdp';

const cfg: OidcConfig = { issuer: 'https://idp.test', clientId: 'studio', scopes: ['openid', 'offline_access'] };
const crypto = webcrypto as unknown as Crypto;

function browser(idp: FakeIdp, opts: { tamperState?: boolean; error?: string; hang?: boolean } = {}) {
  let opened = '';
  const login: SystemBrowserLogin = {
    begin: async () => ({ redirectUri: 'http://127.0.0.1:50000/callback' }),
    openBrowser: async (u) => {
      opened = u;
    },
    awaitCallback: async () => {
      if (opts.hang === true) throw new Error('timeout');
      return idp.authorize(opened, opts);
    },
  };
  return { login, opened: () => opened };
}

describe('interactive sign-in through the system browser', () => {
  it('completes the PKCE code flow and returns tokens (id_token discarded)', async () => {
    const idp = new FakeIdp();
    const b = browser(idp);
    const r = await signInWithSystemBrowser({ config: cfg, fetch: idp.fetch, login: b.login, now: () => 1000, crypto });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tokens.accessToken).toBe('xoak_good');
      expect(r.value.tokens.expiresAt).toBe(1000 + 3600_000);
      expect(JSON.stringify(r.value)).not.toContain('ignored.id.token');
    }
    // No client secret and no access token ever appeared in the authorization URL.
    expect(b.opened()).not.toMatch(/client_secret|access_token/);
    const tokenCall = idp.calls.find((c) => c.url.endsWith('/token'));
    expect(tokenCall?.body).not.toMatch(/client_secret/);
  });
  it('rejects a forged callback (wrong state) without ever calling the token endpoint', async () => {
    const idp = new FakeIdp();
    const r = await signInWithSystemBrowser({
      config: cfg,
      fetch: idp.fetch,
      login: browser(idp, { tamperState: true }).login,
      now: () => 0,
      crypto,
    });
    expect(!r.ok && r.failure.kind).toBe('state_mismatch');
    expect(idp.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });
  it('stops on a provider that reports another issuer, before opening any browser', async () => {
    const idp = new FakeIdp();
    idp.discoveryIssuer = 'https://evil.test';
    const b = browser(idp);
    const r = await signInWithSystemBrowser({ config: cfg, fetch: idp.fetch, login: b.login, now: () => 0, crypto });
    expect(!r.ok && r.failure.kind).toBe('discovery');
    expect(b.opened()).toBe('');
  });
  it('reports a declined sign-in and a timeout distinctly', async () => {
    const idp = new FakeIdp();
    const denied = await signInWithSystemBrowser({
      config: cfg,
      fetch: idp.fetch,
      login: browser(idp, { error: 'access_denied' }).login,
      now: () => 0,
      crypto,
    });
    expect(!denied.ok && denied.failure.kind).toBe('provider_error');
    const timeout = await signInWithSystemBrowser({
      config: cfg,
      fetch: idp.fetch,
      login: browser(idp, { hang: true }).login,
      now: () => 0,
      crypto,
    });
    expect(!timeout.ok && timeout.failure.kind).toBe('cancelled');
  });
  it('does not accept a replayed authorization code', async () => {
    const idp = new FakeIdp();
    // First exchange consumes the code; replaying the same callback must fail at the provider.
    let cb = '';
    let opened = '';
    const login: SystemBrowserLogin = {
      begin: async () => ({ redirectUri: 'http://127.0.0.1:50000/callback' }),
      openBrowser: async (u) => {
        opened = u;
      },
      awaitCallback: async () => (cb = idp.authorize(opened)),
    };
    expect((await signInWithSystemBrowser({ config: cfg, fetch: idp.fetch, login, now: () => 0, crypto })).ok).toBe(true);
    const code = new URLSearchParams(cb).get('code') ?? '';
    const replay = await fetch_replay(idp, code);
    expect(replay.status).toBe(400);
  });
});

async function fetch_replay(idp: FakeIdp, code: string) {
  return idp.fetch('https://idp.test/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'x' }).toString(),
  });
}

async function session(idp: FakeIdp, now: { t: number }, hooks: { onRefreshToken?: (t: string) => void; onEnded?: () => void } = {}) {
  const seeded = idp.seedRefresh();
  const r = await restoreFromRefreshToken({ config: cfg, fetch: idp.fetch, now: () => now.t, ...hooks }, seeded);
  if (!r.ok) throw new Error('setup failed');
  return { s: r.value, seeded };
}

describe('OidcSession: expiry, refresh, revocation, logout', () => {
  it('serves the cached token until shortly before expiry, then refreshes once (single-flight)', async () => {
    const idp = new FakeIdp();
    const now = { t: 0 };
    const { s } = await session(idp, now);
    const before = idp.calls.filter((c) => c.body.includes('refresh_token')).length;
    now.t = 3600_000 - 120_000;
    await s.getAccessToken();
    expect(idp.calls.filter((c) => c.body.includes('refresh_token')).length).toBe(before); // not yet
    now.t = 3600_000 - 30_000; // inside the 60s skew
    const [a, b] = await Promise.all([s.getAccessToken(), s.getAccessToken()]);
    expect(a.ok && b.ok).toBe(true);
    expect(idp.calls.filter((c) => c.body.includes('refresh_token')).length).toBe(before + 1);
  });
  it('persists a rotated refresh token', async () => {
    const idp = new FakeIdp();
    const now = { t: 0 };
    const onRefreshToken = vi.fn();
    const { s, seeded } = await session(idp, now, { onRefreshToken });
    onRefreshToken.mockClear();
    now.t = 3600_000;
    await s.getAccessToken();
    expect(onRefreshToken).toHaveBeenCalledTimes(1);
    expect(onRefreshToken.mock.calls[0]?.[0]).not.toBe(seeded);
  });
  it('a TRANSIENT refresh failure keeps the session and the credential', async () => {
    const idp = new FakeIdp();
    const now = { t: 0 };
    const onEnded = vi.fn();
    const { s } = await session(idp, now, { onEnded });
    now.t = 3600_000;
    idp.tokenDown = 'network';
    const r1 = await s.getAccessToken();
    expect(!r1.ok && r1.failure.kind).toBe('network');
    idp.tokenDown = '503';
    const r2 = await s.getAccessToken();
    expect(!r2.ok && r2.failure.kind).toBe('network');
    expect(onEnded).not.toHaveBeenCalled();
    idp.tokenDown = 'none';
    expect((await s.getAccessToken()).ok).toBe(true); // recovered without re-login
  });
  it('a REVOKED refresh token (invalid_grant) ends the session permanently and notifies once', async () => {
    const idp = new FakeIdp();
    const now = { t: 0 };
    const onEnded = vi.fn();
    const { s } = await session(idp, now, { onEnded });
    now.t = 3600_000;
    idp.refreshBehaviour = 'invalid_grant';
    const r = await s.getAccessToken();
    expect(!r.ok && r.failure.kind).toBe('invalid_grant');
    expect(onEnded).toHaveBeenCalledTimes(1);
    idp.refreshBehaviour = 'ok';
    expect((await s.getAccessToken()).ok).toBe(false); // stays ended; no silent resurrection
  });
  it('restoring with a revoked stored refresh token fails with invalid_grant (caller may discard)', async () => {
    const idp = new FakeIdp();
    const r = await restoreFromRefreshToken({ config: cfg, fetch: idp.fetch, now: () => 0 }, 'rt_unknown');
    expect(!r.ok && r.failure.kind).toBe('invalid_grant');
  });
  it('restoring while the provider is unreachable fails as network (caller must KEEP the credential)', async () => {
    const idp = new FakeIdp();
    idp.tokenDown = 'network';
    const r = await restoreFromRefreshToken({ config: cfg, fetch: idp.fetch, now: () => 0 }, idp.seedRefresh());
    expect(!r.ok && r.failure.kind).toBe('network');
  });
  it('sign-out revokes the refresh token at the provider and the session stays closed', async () => {
    const idp = new FakeIdp();
    const { s } = await session(idp, { t: 0 });
    const rt = s.refreshToken;
    await s.signOut();
    expect(idp.revoked).toContain(rt);
    expect((await s.getAccessToken()).ok).toBe(false);
  });
  it('sign-out still completes locally if revocation fails', async () => {
    const idp = new FakeIdp();
    const { s } = await session(idp, { t: 0 });
    const ep = await discoverProvider(cfg, idp.fetch);
    expect(ep.ok).toBe(true);
    const failing = new OidcSession(
      {
        config: cfg,
        endpoints: ep.ok ? ep.value : (undefined as never),
        fetch: async () => {
          throw new TypeError('x');
        },
        now: () => 0,
      },
      { accessToken: 'a', expiresAt: 1e12, refreshToken: 'r' },
    );
    await expect(failing.signOut()).resolves.toBeUndefined();
    expect(s).toBeDefined();
  });
});
