import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { decodeCredential, encodeCredential } from '../../src/auth/envelope';
import type { OidcConfig } from '../../src/auth/oidc';
import type { SystemBrowserLogin } from '../../src/auth/oidcSession';
import { CredentialStoreError, createWebShellServices, type ShellServices } from '../../src/shell/services';
import { FakeIdp } from '../fakeIdp';
import { FakeXo } from '../fakeXo';
import { withShell } from '../shell';

const oidc: OidcConfig = { issuer: 'https://idp.test', clientId: 'studio', scopes: ['openid', 'offline_access'] };

interface Harness {
  idp: FakeIdp;
  api: FakeXo;
  store: Map<string, string>;
  shell: ShellServices;
  fetchImpl: (i: string, init?: RequestInit) => Promise<Response>;
  failLoad: boolean;
  failSave: boolean;
  browserOpened: string[];
}

function harness(): Harness {
  const idp = new FakeIdp();
  const api = new FakeXo();
  const store = new Map<string, string>();
  const h: Harness = {
    idp,
    api,
    store,
    failLoad: false,
    failSave: false,
    browserOpened: [],
    fetchImpl: (i, init) => (i.startsWith('https://idp.test') ? idp.fetch(i, init) : api.fetch(i, init)),
    shell: undefined as never,
  };
  let opened = '';
  const login: SystemBrowserLogin = {
    begin: async () => ({ redirectUri: 'http://127.0.0.1:50000/callback' }),
    openBrowser: async (u) => {
      opened = u;
      h.browserOpened.push(u);
    },
    awaitCallback: async () => idp.authorize(opened),
  };
  h.shell = {
    kind: 'desktop',
    capabilities: { persistentCredentials: true, systemBrowserLogin: true },
    login,
    credentials: {
      load: async () => {
        if (h.failLoad) throw new CredentialStoreError('unavailable', 'no keychain');
        return store.get('k') ?? null;
      },
      save: async (v) => {
        if (h.failSave) throw new CredentialStoreError('unavailable', 'no keychain');
        store.set('k', v);
      },
      clear: async () => void store.delete('k'),
    },
  };
  return h;
}

const renderApp = (h: Harness, extra: { devSignIn?: boolean } = {}) =>
  render(withShell(<App fetchImpl={h.fetchImpl} oidc={oidc} {...extra} />, h.shell));

describe('production sign-in (OIDC) through the app', () => {
  it('signs in via the system browser, stores only a refresh token, and signs out with revocation', async () => {
    const h = harness();
    const user = userEvent.setup();
    renderApp(h);
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    const stored = decodeCredential(h.store.get('k') ?? '');
    expect(stored?.kind).toBe('oidc-refresh');
    expect(h.store.get('k')).not.toContain('xoak_good'); // the access token is never persisted
    expect(h.browserOpened[0]).toContain('code_challenge_method=S256');
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(h.store.has('k')).toBe(false));
    await waitFor(() => expect(h.idp.revoked.length).toBe(1));
  });

  it('does NOT pretend success when the XO API rejects the IdP token (current API has no OIDC support)', async () => {
    const h = harness();
    h.idp.accessToken = 'jwt.that.the.api.cannot.verify';
    const user = userEvent.setup();
    renderApp(h);
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    expect(await screen.findByText(/XO did not accept this sign-in/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(h.store.has('k')).toBe(false);
    expect(h.idp.revoked.length).toBe(1); // the useless grant is revoked, not left behind
  });

  it('shows a clear failure for a forged callback and stays signed out', async () => {
    const h = harness();
    const login = h.shell.login as SystemBrowserLogin;
    const forged: SystemBrowserLogin = { ...login, awaitCallback: async () => 'code=stolen&state=attacker' };
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={h.fetchImpl} oidc={oidc} />, { ...h.shell, login: forged }));
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    expect(await screen.findByText(/did not match this sign-in attempt/i)).toBeInTheDocument();
    expect(h.idp.calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });

  it('restores from a stored refresh token', async () => {
    const h = harness();
    h.store.set(
      'k',
      encodeCredential({ kind: 'oidc-refresh', refreshToken: h.idp.seedRefresh(), issuer: oidc.issuer, clientId: oidc.clientId }),
    );
    renderApp(h);
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('a revoked stored refresh token is discarded and the user told', async () => {
    const h = harness();
    h.store.set('k', encodeCredential({ kind: 'oidc-refresh', refreshToken: 'rt_revoked', issuer: oidc.issuer, clientId: oidc.clientId }));
    renderApp(h);
    expect(await screen.findByText(/no longer valid/i)).toBeInTheDocument();
    expect(h.store.has('k')).toBe(false);
  });

  it('an unreachable identity provider does NOT delete the stored credential', async () => {
    const h = harness();
    const kept = encodeCredential({
      kind: 'oidc-refresh',
      refreshToken: h.idp.seedRefresh(),
      issuer: oidc.issuer,
      clientId: oidc.clientId,
    });
    h.store.set('k', kept);
    h.idp.tokenDown = 'network';
    renderApp(h);
    expect(await screen.findByText(/could not reach the identity provider/i)).toBeInTheDocument();
    expect(h.store.get('k')).toBe(kept);
  });

  it('a stored token for a different issuer/client is discarded, never sent to the configured provider', async () => {
    const h = harness();
    h.store.set('k', encodeCredential({ kind: 'oidc-refresh', refreshToken: 'rt_x', issuer: 'https://other.test', clientId: 'studio' }));
    renderApp(h);
    expect(await screen.findByText(/settings have changed/i)).toBeInTheDocument();
    expect(h.store.has('k')).toBe(false);
    expect(h.idp.calls.length).toBe(0);
  });

  it('says so when secure storage is unavailable on load, and still allows signing in', async () => {
    const h = harness();
    h.failLoad = true;
    renderApp(h);
    expect(await screen.findByText(/secure storage is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with your organisation/i })).toBeInTheDocument();
  });

  it('says so when a credential cannot be saved, and the session still works', async () => {
    const h = harness();
    h.failSave = true;
    const user = userEvent.setup();
    renderApp(h);
    await user.click(await screen.findByRole('button', { name: /sign in with your organisation/i }));
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(h.store.has('k')).toBe(false);
  });
});

describe('development sign-in is explicit and can be switched off', () => {
  it('is labelled as development-only', async () => {
    const h = harness();
    renderApp(h);
    expect(await screen.findByRole('form', { name: /development sign-in/i })).toBeInTheDocument();
    expect(screen.getByText(/not for production use/i)).toBeInTheDocument();
  });
  it('is absent when disabled; the OIDC option remains', async () => {
    const h = harness();
    renderApp(h, { devSignIn: false });
    expect(await screen.findByRole('button', { name: /sign in with your organisation/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/access key/i)).not.toBeInTheDocument();
  });
  it('a stored dev key is refused and cleared when dev sign-in is disabled', async () => {
    const h = harness();
    h.store.set('k', encodeCredential({ kind: 'dev-key', key: h.api.validKey }));
    renderApp(h, { devSignIn: false });
    await screen.findByRole('button', { name: /sign in with your organisation/i });
    expect(h.store.has('k')).toBe(false);
  });
  it('web shell with OIDC configured and no dev sign-in explains it is not yet available (no dead end, no fake button)', async () => {
    const h = harness();
    render(withShell(<App fetchImpl={h.fetchImpl} oidc={oidc} devSignIn={false} />, createWebShellServices()));
    expect(await screen.findByText(/not yet available in the browser/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in with your organisation/i })).not.toBeInTheDocument();
  });
});
