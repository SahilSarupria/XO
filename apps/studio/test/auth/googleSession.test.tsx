import { webcrypto } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { decodeCredential, encodeCredential } from '../../src/auth/envelope';
import { parseOidcConfig, type OidcConfig } from '../../src/auth/oidc';
import type { SystemBrowserLogin } from '../../src/auth/oidcSession';
import { XoAuthApi, XoSession, restoreXoSession, signInWithGoogle } from '../../src/auth/xoSession';
import type { ShellServices } from '../../src/shell/services';
import { FakeGoogle, FakeXoSessions } from '../fakeGoogle';
import { withShell } from '../shell';

const crypto = webcrypto as unknown as Crypto;
const cfg: OidcConfig = {
  issuer: 'https://accounts.google.test',
  clientId: '123-studio.apps.googleusercontent.test',
  scopes: ['openid'],
  provider: 'google',
};

function rig(browserOpts: { tamperState?: boolean; error?: string; hang?: boolean } = {}) {
  const google = new FakeGoogle();
  const xo = new FakeXoSessions();
  const opened: string[] = [];
  const login: SystemBrowserLogin = {
    begin: async () => ({ redirectUri: 'http://127.0.0.1:50000/callback' }),
    openBrowser: async (u) => void opened.push(u),
    awaitCallback: async () => {
      if (browserOpts.hang === true) throw new Error('timeout');
      return google.authorize(opened[opened.length - 1] ?? '', browserOpts);
    },
  };
  const api = new XoAuthApi('/api', xo.fetch);
  return { google, xo, login, opened, api };
}

describe('config: the Google provider', () => {
  it('defaults to scope openid only, accepts the setting, and refuses offline_access, an audience, a secret or an unknown provider', () => {
    const ok = parseOidcConfig({ issuer: 'https://accounts.google.com', clientId: 'c', provider: 'google' });
    expect(ok.ok && ok.value).toMatchObject({ provider: 'google', scopes: ['openid'] });
    expect(
      parseOidcConfig({ issuer: 'https://accounts.google.com', clientId: 'c', provider: 'google', scopes: ['openid', 'offline_access'] })
        .ok,
    ).toBe(false);
    expect(parseOidcConfig({ issuer: 'https://accounts.google.com', clientId: 'c', provider: 'google', audience: 'x' }).ok).toBe(false);
    expect(parseOidcConfig({ issuer: 'https://accounts.google.com', clientId: 'c', provider: 'google', clientSecret: 's' }).ok).toBe(false);
    expect(parseOidcConfig({ issuer: 'https://accounts.google.com', clientId: 'c', provider: 'okta' }).ok).toBe(false);
    // Google's issuer selects the Google path by itself (the native launcher passes only issuer and client id).
    const implicit = parseOidcConfig({ issuer: 'https://accounts.google.com', clientId: 'c' });
    expect(implicit.ok && implicit.value).toMatchObject({ provider: 'google', scopes: ['openid'] });
    // The generic provider path is unchanged: still defaults to offline_access and has no provider.
    const generic = parseOidcConfig({ issuer: 'https://idp.example', clientId: 'c' });
    expect(generic.ok && generic.value.scopes).toEqual(['openid', 'offline_access']);
    expect(generic.ok && generic.value.provider).toBeUndefined();
  });
});

describe('envelope: xo-session', () => {
  const good = `xoar_${'a'.repeat(43)}`;
  it('round-trips and rejects anything that is not an XO refresh credential', () => {
    const c = { kind: 'xo-session' as const, refreshCredential: good, issuer: cfg.issuer, clientId: cfg.clientId };
    expect(decodeCredential(encodeCredential(c))).toEqual(c);
    for (const bad of ['1//google-refresh-token', 'xoak_dev', `xoas_${'a'.repeat(43)}`, `xoar_${'a'.repeat(42)}`, '']) {
      expect(decodeCredential(encodeCredential({ ...c, refreshCredential: bad }))).toBeNull();
    }
  });
});

describe('signInWithGoogle', () => {
  it('runs code+PKCE with the server challenge nonce, hands the ID token to XO once, and keeps only XO credentials', async () => {
    const { google, xo, login, opened, api } = rig();
    const r = await signInWithGoogle({ config: cfg, authFetch: google.fetch, api, login, now: () => 0, crypto });
    expect(r.ok).toBe(true);
    const q = google.lastAuth!;
    expect(q.get('scope')).toBe('openid');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('nonce')).toBe('nonce-1'); // the SERVER's nonce, not one Studio invented
    expect(q.get('state')?.length).toBeGreaterThan(20);
    expect(q.has('audience')).toBe(false);
    expect(q.get('scope')).not.toContain('offline_access');
    expect(opened[0]).not.toMatch(/client_secret|access_token|id_token/);
    expect(google.calls.find((c) => c.url.endsWith('/token'))?.body).not.toMatch(/client_secret/);

    // XO received the ID token exactly once, and nothing else Google issued.
    const exchanges = xo.calls.filter((c) => c.path === '/auth/session');
    expect(exchanges).toHaveLength(1);
    expect(JSON.parse(exchanges[0]!.body)).toEqual({ challengeId: 'challenge-1', idToken: 'idtok.nonce-1' });
    for (const c of xo.calls) {
      expect(c.body).not.toContain('ya29.google-opaque-access-token');
      expect(c.body).not.toContain('1//google-refresh-token');
      expect(c.authorization ?? '').not.toContain('ya29');
      expect(c.authorization ?? '').not.toContain('idtok');
    }
    // The result carries XO credentials only.
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/ya29|1\/\/google|idtok/);
    expect(r.ok && r.value.accessCredential).toMatch(/^xoas_/);
    expect(r.ok && r.value.refreshCredential).toMatch(/^xoar_/);
    // Google's refresh token was revoked (best effort), not kept.
    await vi.waitFor(() => expect(google.revoked).toEqual(['1//google-refresh-token']));
  });

  it('succeeds even if revoking the Google refresh token fails (sign-in never depends on it)', async () => {
    const { google, login, api } = rig();
    google.revokeFails = true;
    const r = await signInWithGoogle({ config: cfg, authFetch: google.fetch, api, login, now: () => 0, crypto });
    expect(r.ok).toBe(true);
  });

  it('a forged callback (wrong state) never reaches Google or XO again', async () => {
    const { google, xo, login, api } = rig({ tamperState: true });
    const r = await signInWithGoogle({ config: cfg, authFetch: google.fetch, api, login, now: () => 0, crypto });
    expect(!r.ok && r.failure.kind).toBe('state_mismatch');
    expect(google.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
    expect(xo.calls.some((c) => c.path === '/auth/session')).toBe(false);
  });

  it('decline, timeout, provider outage and a missing ID token fail distinctly and never call XO to exchange', async () => {
    const denied = rig({ error: 'access_denied' });
    expect(
      (await signInWithGoogle({ config: cfg, authFetch: denied.google.fetch, api: denied.api, login: denied.login, now: () => 0, crypto }))
        .ok,
    ).toBe(false);
    const hung = rig({ hang: true });
    const h = await signInWithGoogle({ config: cfg, authFetch: hung.google.fetch, api: hung.api, login: hung.login, now: () => 0, crypto });
    expect(!h.ok && h.failure.kind).toBe('cancelled');
    const down = rig();
    down.google.tokenDown = '503';
    const d = await signInWithGoogle({ config: cfg, authFetch: down.google.fetch, api: down.api, login: down.login, now: () => 0, crypto });
    expect(!d.ok && d.failure.kind).toBe('network');
    const noId = rig();
    noId.google.omitIdToken = true;
    const m = await signInWithGoogle({ config: cfg, authFetch: noId.google.fetch, api: noId.api, login: noId.login, now: () => 0, crypto });
    expect(!m.ok && m.failure.kind).toBe('malformed');
    for (const x of [denied, hung, down, noId]) expect(x.xo.calls.some((c) => c.path === '/auth/session')).toBe(false);
  });

  it('XO unreachable at the start stops before any browser opens; an unbound identity is reported as such', async () => {
    const a = rig();
    a.xo.challengeDown = 'network';
    const r = await signInWithGoogle({ config: cfg, authFetch: a.google.fetch, api: a.api, login: a.login, now: () => 0, crypto });
    expect(!r.ok && r.failure.kind).toBe('network');
    expect(a.opened).toHaveLength(0);
    const b = rig();
    b.xo.bound = false;
    const u = await signInWithGoogle({ config: cfg, authFetch: b.google.fetch, api: b.api, login: b.login, now: () => 0, crypto });
    expect(!u.ok && u.failure.message).toMatch(/administrator/i);
  });

  it('a provider that reports another issuer is refused before the browser opens', async () => {
    const a = rig();
    const evil: typeof a.google.fetch = async (i, init) => {
      const res = await a.google.fetch(i, init);
      if (!i.endsWith('/.well-known/openid-configuration')) return res;
      return new Response(JSON.stringify({ ...(await res.json()), issuer: 'https://evil.test' }), { status: 200 });
    };
    const r = await signInWithGoogle({ config: cfg, authFetch: evil, api: a.api, login: a.login, now: () => 0, crypto });
    expect(!r.ok && r.failure.kind).toBe('discovery');
    expect(a.opened).toHaveLength(0);
    expect(a.xo.calls).toHaveLength(0);
  });
});

async function liveSession(now: { t: number }, hooks: { onRefreshCredential?: (c: string) => void; onEnded?: () => void } = {}) {
  const { google, xo, login, api } = rig();
  xo.now = () => now.t;
  const r = await signInWithGoogle({ config: cfg, authFetch: google.fetch, api, login, now: () => now.t, crypto });
  if (!r.ok) throw new Error('setup failed');
  return { xo, session: new XoSession({ api, now: () => now.t, ...hooks }, r.value), tokens: r.value, api };
}

describe('XoSession: expiry, refresh, revocation, logout', () => {
  it('serves the cached access credential until shortly before its 15-minute expiry, then refreshes once (single-flight) and persists the rotated credential', async () => {
    const now = { t: 1_000_000 };
    const persisted = vi.fn();
    const { xo, session, tokens } = await liveSession(now, { onRefreshCredential: persisted });
    now.t += 13 * 60_000;
    expect((await session.getAccessToken()).ok).toBe(true);
    expect(xo.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(0);
    now.t += 90_000; // inside the 60 s skew of the 15-minute expiry
    const [a, b] = await Promise.all([session.getAccessToken(), session.getAccessToken()]);
    expect(a.ok && b.ok).toBe(true);
    expect(xo.calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persisted.mock.calls[0]?.[0]).not.toBe(tokens.refreshCredential);
    expect(session.refreshCredential).toBe(persisted.mock.calls[0]?.[0]);
  });

  it('a TRANSIENT refresh failure keeps the session and the credential; a permanent XO verdict ends it, once', async () => {
    const now = { t: 1_000_000 };
    const onEnded = vi.fn();
    const { xo, session } = await liveSession(now, { onEnded });
    now.t += 16 * 60_000;
    xo.refreshDown = 'network';
    const n = await session.getAccessToken();
    expect(!n.ok && n.failure.kind).toBe('network');
    xo.refreshDown = '503';
    const s = await session.getAccessToken();
    expect(!s.ok && s.failure.kind).toBe('network');
    expect(onEnded).not.toHaveBeenCalled();
    xo.refreshDown = 'none';
    expect((await session.getAccessToken()).ok).toBe(true); // recovered without signing in again

    now.t += 16 * 60_000;
    xo.revokeAll(); // binding revoked / session killed server-side
    const gone = await session.getAccessToken();
    expect(!gone.ok && gone.failure.kind).toBe('invalid_grant');
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect((await session.getAccessToken()).ok).toBe(false); // stays ended
  });

  it('sign-out asks XO to revoke the session with the access credential and stays closed; a network failure there still completes locally', async () => {
    const now = { t: 1_000_000 };
    const { xo, session, tokens } = await liveSession(now);
    await session.signOut();
    expect(xo.logouts).toEqual([tokens.accessCredential]);
    expect((await session.getAccessToken()).ok).toBe(false);

    const second = await liveSession({ t: 1_000_000 });
    second.xo.logoutDown = true;
    await expect(second.session.signOut()).resolves.toBeUndefined();
    expect((await second.session.getAccessToken()).ok).toBe(false);
  });

  it('restoring from a stored credential rotates it; a rejected one is invalid_grant and an unreachable XO keeps it', async () => {
    const { xo, tokens, api } = await liveSession({ t: 1_000_000 });
    const persisted = vi.fn();
    const ok = await restoreXoSession({ api, now: () => 1_000_000, onRefreshCredential: persisted }, tokens.refreshCredential);
    expect(ok.ok).toBe(true);
    expect(persisted).toHaveBeenCalledTimes(1);
    const reused = await restoreXoSession({ api, now: () => 1_000_000 }, tokens.refreshCredential); // already used
    expect(!reused.ok && reused.failure.kind).toBe('invalid_grant');
    xo.refreshDown = 'network';
    const down = await restoreXoSession({ api, now: () => 1_000_000 }, `xoar_${'z'.repeat(43)}`);
    expect(!down.ok && down.failure.kind).toBe('network');
  });
});

// ---------------------------------------------------------------- through the app (keychain, sign-in, sign-out)

function appRig() {
  const google = new FakeGoogle();
  const xo = new FakeXoSessions();
  const store = new Map<string, string>();
  const opened: string[] = [];
  const fetchImpl = (i: string, init?: RequestInit) =>
    i.startsWith('https://accounts.google.test') ? google.fetch(i, init) : xo.fetch(i, init);
  const shell: ShellServices = {
    kind: 'desktop',
    capabilities: { persistentCredentials: true, systemBrowserLogin: true },
    login: {
      begin: async () => ({ redirectUri: 'http://127.0.0.1:50000/callback' }),
      openBrowser: async (u) => void opened.push(u),
      awaitCallback: async () => google.authorize(opened[opened.length - 1] ?? ''),
    },
    credentials: {
      load: async () => store.get('k') ?? null,
      save: async (v) => void store.set('k', v),
      clear: async () => void store.delete('k'),
    },
  };
  return { google, xo, store, shell, fetchImpl };
}

describe('Google sign-in through the app', () => {
  it('signs in, stores ONLY the XO refresh credential in the keychain (no Google token, no access credential), and signs out through XO', async () => {
    const h = appRig();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={h.fetchImpl} oidc={cfg} />, h.shell));
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    const raw = h.store.get('k') ?? '';
    expect(decodeCredential(raw)?.kind).toBe('xo-session');
    for (const secret of ['ya29', '1//google', 'idtok', 'xoas_']) expect(raw).not.toContain(secret);
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(h.store.has('k')).toBe(false));
    await waitFor(() => expect(h.xo.logouts).toHaveLength(1));
  });

  it('sign-out clears the local credential even when XO cannot be reached', async () => {
    const h = appRig();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={h.fetchImpl} oidc={cfg} />, h.shell));
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    await screen.findByRole('button', { name: /sign out/i });
    h.xo.logoutDown = true;
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(h.store.has('k')).toBe(false));
    expect(await screen.findByRole('button', { name: /sign in with your organisation/i })).toBeInTheDocument();
  });

  it('an unbound identity is told so, no session is stored, and nothing is left signed in', async () => {
    const h = appRig();
    h.xo.bound = false;
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={h.fetchImpl} oidc={cfg} />, h.shell));
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    expect(await screen.findByText(/administrator may not have enabled XO/i)).toBeInTheDocument();
    expect(h.store.has('k')).toBe(false);
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('restores from a stored XO credential, discards a rejected one, and keeps one on a transient failure', async () => {
    const first = appRig();
    const user = userEvent.setup();
    const a = render(withShell(<App fetchImpl={first.fetchImpl} oidc={cfg} />, first.shell));
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    await screen.findByRole('button', { name: /sign out/i });
    const saved = first.store.get('k') ?? '';
    a.unmount();

    // A fresh app start with the saved credential restores the session (rotating the credential).
    const second = { ...first, store: new Map([['k', saved]]) };
    second.shell = {
      ...first.shell,
      credentials: {
        load: async () => second.store.get('k') ?? null,
        save: async (v) => void second.store.set('k', v),
        clear: async () => void second.store.delete('k'),
      },
    };
    const b = render(withShell(<App fetchImpl={first.fetchImpl} oidc={cfg} />, second.shell));
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(second.store.get('k')).not.toBe(saved);
    b.unmount();

    // The old (already rotated) credential is now rejected: discarded, user told.
    const third = new Map([['k', saved]]);
    const shell3: ShellServices = {
      ...first.shell,
      credentials: {
        load: async () => third.get('k') ?? null,
        save: async (v) => void third.set('k', v),
        clear: async () => void third.delete('k'),
      },
    };
    const c = render(withShell(<App fetchImpl={first.fetchImpl} oidc={cfg} />, shell3));
    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
    expect(third.has('k')).toBe(false);
    c.unmount();

    // A transient failure keeps the credential.
    const fourth = new Map([
      [
        'k',
        encodeCredential({ kind: 'xo-session', refreshCredential: `xoar_${'q'.repeat(43)}`, issuer: cfg.issuer, clientId: cfg.clientId }),
      ],
    ]);
    const shell4: ShellServices = {
      ...first.shell,
      credentials: {
        load: async () => fourth.get('k') ?? null,
        save: async (v) => void fourth.set('k', v),
        clear: async () => void fourth.delete('k'),
      },
    };
    first.xo.refreshDown = 'network';
    render(withShell(<App fetchImpl={first.fetchImpl} oidc={cfg} />, shell4));
    await screen.findByRole('button', { name: /sign in with your organisation/i });
    expect(fourth.has('k')).toBe(true);
  });

  it('settings changes discard a stored XO credential, and a stored generic-OIDC credential is not used for the Google provider', async () => {
    const h = appRig();
    const other: OidcConfig = { ...cfg, clientId: 'a-different-client' };
    h.store.set(
      'k',
      encodeCredential({ kind: 'xo-session', refreshCredential: `xoar_${'q'.repeat(43)}`, issuer: cfg.issuer, clientId: cfg.clientId }),
    );
    render(withShell(<App fetchImpl={h.fetchImpl} oidc={other} />, h.shell));
    expect(await screen.findByText(/settings have changed/i)).toBeInTheDocument();
    expect(h.store.has('k')).toBe(false);
    expect(h.xo.calls).toHaveLength(0); // never sent to XO

    const g = appRig();
    g.store.set('k', encodeCredential({ kind: 'oidc-refresh', refreshToken: 'rt_x', issuer: cfg.issuer, clientId: cfg.clientId }));
    render(withShell(<App fetchImpl={g.fetchImpl} oidc={cfg} />, g.shell));
    expect(await screen.findByText(/settings have changed/i)).toBeInTheDocument();
    expect(g.store.has('k')).toBe(false);
  });
});
