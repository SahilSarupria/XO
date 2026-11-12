import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { XoClient, type ApiProblem, type FetchLike } from '../platform/client';
import { Button, ProblemNotice, Spinner } from './primitives';
import { SessionProvider, useSession } from './session';
import { WorkspaceHome } from './WorkspaceHome';
import { useShell } from '../shell/services';
import { decodeCredential, encodeCredential, type StoredCredential } from '../auth/envelope';
import type { AuthFailure, OidcConfig } from '../auth/oidc';
import { OidcSession, restoreFromRefreshToken, signInWithSystemBrowser } from '../auth/oidcSession';
import { XoAuthApi, XoSession, restoreXoSession, signInWithGoogle } from '../auth/xoSession';

export interface AppProps {
  /** Test seam: lets tests inject a fake transport. Production uses the browser's fetch. */
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
  /** Production sign-in settings (provider-neutral OIDC). Absent = development sign-in only. */
  readonly oidc?: OidcConfig;
  /** Show the development access-key sign-in. Default true. */
  readonly devSignIn?: boolean;
  readonly now?: () => number;
}

type Auth =
  | { readonly kind: 'dev-key'; readonly key: string }
  | { readonly kind: 'oidc'; readonly session: OidcSession }
  | { readonly kind: 'xo'; readonly session: XoSession };

interface Notice {
  readonly tone: 'danger' | 'info';
  readonly text: string;
}

const failureNotice = (f: AuthFailure): Notice => ({ tone: 'danger', text: f.message });

/**
 * Credentials: the dev key and OIDC access token live in memory. Only a shell that reports
 * `persistentCredentials` ever stores anything (a dev key or an OIDC *refresh* token, in the OS
 * keychain); the web shell stores nothing. The client never decides who the user is or what they
 * may do: the API derives the principal from the credential (docs/studio/AUTH_API_CONTRACT.md).
 */
export function App(props: AppProps) {
  const shell = useShell();
  const now = props.now ?? Date.now;
  const [auth, setAuth] = useState<Auth | null>(null);
  const [restoring, setRestoring] = useState(shell.capabilities.persistentCredentials);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [problem, setProblem] = useState<ApiProblem | undefined>();
  const oidcCfg = props.oidc;
  const fetchFn = useMemo<FetchLike>(() => props.fetchImpl ?? ((i, init) => globalThis.fetch(i, init)), [props.fetchImpl]);

  const persist = useCallback(
    (c: StoredCredential) => {
      if (!shell.capabilities.persistentCredentials) return;
      shell.credentials.save(encodeCredential(c)).catch(() => {
        setNotice({ tone: 'info', text: 'Secure storage is unavailable on this device, so you will need to sign in again next time.' });
      });
    },
    [shell],
  );
  const forget = useCallback(async () => {
    try {
      await shell.credentials.clear();
    } catch {
      setNotice({ tone: 'info', text: 'Secure storage is unavailable; a saved sign-in could not be removed.' });
    }
  }, [shell]);

  const startedRef = useRef(false);
  // Restore from the credential store (desktop only). Verified with real calls; a credential is
  // discarded only when the server/provider PERMANENTLY rejected it, never on a transient failure.
  useEffect(() => {
    if (!shell.capabilities.persistentCredentials || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        let raw: string | null;
        try {
          raw = await shell.credentials.load();
        } catch {
          setNotice({ tone: 'info', text: 'Secure storage is unavailable on this device, so a saved sign-in could not be used.' });
          return;
        }
        if (raw === null) return;
        const stored = decodeCredential(raw);
        if (stored === null) {
          await forget();
          return;
        }
        if (stored.kind === 'dev-key') {
          if (props.devSignIn === false) {
            await forget();
            return;
          }
          const r = await new XoClient({
            apiKey: stored.key,
            fetch: fetchFn,
            ...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {}),
          }).listWorkspaces();
          if (r.ok) setAuth({ kind: 'dev-key', key: stored.key });
          else {
            setProblem(r.problem);
            if (r.problem.kind !== 'network') await forget();
          }
          return;
        }
        if (stored.kind === 'xo-session') {
          // An XO session is only valid for the Google sign-in it came from; any change of settings discards it.
          if (
            oidcCfg === undefined ||
            oidcCfg.provider !== 'google' ||
            stored.issuer !== oidcCfg.issuer ||
            stored.clientId !== oidcCfg.clientId
          ) {
            await forget();
            setNotice({ tone: 'info', text: 'Sign-in settings have changed, so you need to sign in again.' });
            return;
          }
          const xo = await restoreXoSession(
            {
              api: new XoAuthApi(props.baseUrl, fetchFn),
              now,
              onRefreshCredential: (t) => persist({ ...stored, refreshCredential: t }),
              onEnded: () => endSession(),
            },
            stored.refreshCredential,
          );
          if (xo.ok) setAuth({ kind: 'xo', session: xo.value });
          else if (xo.failure.kind === 'invalid_grant') {
            await forget();
            setNotice({ tone: 'danger', text: 'Your saved sign-in is no longer valid. Please sign in again.' });
          } else setNotice(failureNotice(xo.failure)); // transient: credential kept
          return;
        }
        // oidc-refresh
        if (
          oidcCfg === undefined ||
          oidcCfg.provider === 'google' ||
          stored.issuer !== oidcCfg.issuer ||
          stored.clientId !== oidcCfg.clientId
        ) {
          await forget();
          setNotice({ tone: 'info', text: 'Sign-in settings have changed, so you need to sign in again.' });
          return;
        }
        const r = await restoreFromRefreshToken(
          {
            config: oidcCfg,
            fetch: fetchFn,
            now,
            onRefreshToken: (t) => persist({ ...stored, refreshToken: t }),
            onEnded: () => endSession(),
          },
          stored.refreshToken,
        );
        if (r.ok) setAuth({ kind: 'oidc', session: r.value });
        else if (r.failure.kind === 'invalid_grant') {
          await forget();
          setNotice({ tone: 'danger', text: 'Your saved sign-in is no longer valid. Please sign in again.' });
        } else setNotice(failureNotice(r.failure)); // transient: credential kept
      } finally {
        setRestoring(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore runs once per mount
  }, []);

  const endSession = useCallback(() => {
    setAuth(null);
    setNotice({ tone: 'danger', text: 'Your session has ended. Please sign in again.' });
    void forget();
  }, [forget]);

  const signOut = useCallback(() => {
    const a = auth;
    setAuth(null);
    setNotice(undefined);
    setProblem(undefined);
    if (a?.kind === 'oidc' || a?.kind === 'xo') void a.session.signOut();
    void forget();
  }, [auth, forget]);

  const connectedDev = useCallback(
    (key: string) => {
      setAuth({ kind: 'dev-key', key });
      persist({ kind: 'dev-key', key });
    },
    [persist],
  );

  const signInExternal = useCallback(async (): Promise<AuthFailure | undefined> => {
    if (oidcCfg === undefined || shell.login === undefined) return { kind: 'config', message: 'Sign-in is not available in this app.' };
    if (oidcCfg.provider === 'google') {
      const api = new XoAuthApi(props.baseUrl, fetchFn);
      const g = await signInWithGoogle({ config: oidcCfg, authFetch: fetchFn, api, login: shell.login, now });
      if (!g.ok) return g.failure;
      let latest = g.value.refreshCredential;
      const xo = new XoSession(
        {
          api,
          now,
          onRefreshCredential: (t) => {
            latest = t;
            persist({ kind: 'xo-session', refreshCredential: t, issuer: oidcCfg.issuer, clientId: oidcCfg.clientId });
          },
          onEnded: () => endSession(),
        },
        g.value,
      );
      // XO verified Google's ID token and bound the identity; confirm with a real authorized call before showing the app.
      const check = await new XoClient({
        bearer: xo.getAccessToken,
        fetch: fetchFn,
        ...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {}),
      }).listWorkspaces();
      if (!check.ok) {
        void xo.signOut();
        return {
          kind: check.problem.kind === 'network' ? 'network' : 'provider_error',
          message: check.problem.kind === 'unauthenticated' ? 'XO did not accept this sign-in.' : check.problem.message,
        };
      }
      persist({ kind: 'xo-session', refreshCredential: latest, issuer: oidcCfg.issuer, clientId: oidcCfg.clientId });
      setNotice(undefined);
      setAuth({ kind: 'xo', session: xo });
      return undefined;
    }
    const r = await signInWithSystemBrowser({ config: oidcCfg, fetch: fetchFn, login: shell.login, now });
    if (!r.ok) return r.failure;
    let latest = r.value.tokens.refreshToken;
    const session = new OidcSession(
      {
        config: oidcCfg,
        endpoints: r.value.endpoints,
        fetch: fetchFn,
        now,
        onRefreshToken: (t) => {
          latest = t;
          persist({ kind: 'oidc-refresh', refreshToken: t, issuer: oidcCfg.issuer, clientId: oidcCfg.clientId });
        },
        onEnded: () => endSession(),
      },
      r.value.tokens,
    );
    // The API, not Studio, decides whether this token is acceptable: verify with a real call.
    const probe = await new XoClient({
      bearer: session.getAccessToken,
      fetch: fetchFn,
      ...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {}),
    }).listWorkspaces();
    if (!probe.ok) {
      void session.signOut();
      return {
        kind: probe.problem.kind === 'network' ? 'network' : 'provider_error',
        message:
          probe.problem.kind === 'unauthenticated'
            ? 'XO did not accept this sign-in. Your administrator may not have enabled single sign-on for XO yet.'
            : probe.problem.message,
      };
    }
    if (latest !== undefined) persist({ kind: 'oidc-refresh', refreshToken: latest, issuer: oidcCfg.issuer, clientId: oidcCfg.clientId });
    setNotice(undefined);
    setAuth({ kind: 'oidc', session });
    return undefined;
  }, [oidcCfg, shell, fetchFn, now, persist, endSession, props.baseUrl]);

  if (restoring) return <Spinner label="Reconnecting to XO" />;
  if (auth === null) {
    return (
      <ConnectScreen
        {...props}
        notice={notice}
        initialProblem={problem}
        onConnected={connectedDev}
        onExternalSignIn={oidcCfg !== undefined && shell.capabilities.systemBrowserLogin ? signInExternal : undefined}
        oidcConfiguredButUnavailable={oidcCfg !== undefined && !shell.capabilities.systemBrowserLogin}
      />
    );
  }
  return (
    <SessionProvider
      {...(auth.kind === 'dev-key' ? { apiKey: auth.key } : { bearer: auth.session.getAccessToken })}
      onSignOut={signOut}
      {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
      {...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {})}
    >
      <Shell />
    </SessionProvider>
  );
}

interface ConnectProps extends AppProps {
  readonly onConnected: (key: string) => void;
  readonly notice: Notice | undefined;
  readonly initialProblem: ApiProblem | undefined;
  readonly onExternalSignIn: (() => Promise<AuthFailure | undefined>) | undefined;
  readonly oidcConfiguredButUnavailable: boolean;
}

function ConnectScreen(props: ConnectProps) {
  const shell = useShell();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>(props.initialProblem);
  const [ssoFailure, setSsoFailure] = useState<AuthFailure | undefined>();
  const showDev = props.devSignIn !== false;

  async function sso() {
    if (props.onExternalSignIn === undefined || ssoBusy) return;
    setSsoBusy(true);
    setSsoFailure(undefined);
    const f = await props.onExternalSignIn();
    setSsoBusy(false);
    if (f !== undefined) setSsoFailure(f);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setProblem(undefined);
    // Verification is a real authenticated call; there is no local "looks valid" shortcut.
    const probe = new XoClient({
      apiKey: trimmed,
      ...(props.fetchImpl !== undefined ? { fetch: props.fetchImpl } : {}),
      ...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {}),
    });
    const r = await probe.listWorkspaces();
    setBusy(false);
    if (r.ok) props.onConnected(trimmed);
    else setProblem(r.problem);
  }

  const hasSso = props.onExternalSignIn !== undefined;
  return (
    <main className="connect">
      <div className="connect-hero" aria-hidden="true">
        <p className="brand">
          <span className="brand-mark" />
          XO Studio
        </p>
        <p className="connect-headline">Turn your documents into rules you can trust.</p>
        <p className="connect-sub">Compile policies into XOs, review what XO found, and run it with a person in the loop.</p>
        <svg className="connect-graph" viewBox="0 0 460 190" fill="none">
          <g stroke="var(--border-strong)" strokeWidth="1.6">
            <path d="M60 95C100 95 100 50 140 50" />
            <path d="M60 95C100 95 100 140 140 140" />
            <path d="M200 50C240 50 240 95 280 95" />
            <path d="M200 140C240 140 240 95 280 95" />
            <path d="M340 95C370 95 370 50 400 50" />
            <path d="M340 95C370 95 370 140 400 140" stroke="var(--accent)" />
          </g>
          <g fill="var(--surface-1)" strokeWidth="1">
            <rect x="0" y="75" width="60" height="40" rx="9" stroke="var(--border-strong)" />
            <rect x="140" y="30" width="60" height="40" rx="9" stroke="var(--accent)" />
            <rect x="140" y="120" width="60" height="40" rx="9" stroke="var(--border-strong)" />
            <rect x="280" y="75" width="60" height="40" rx="9" stroke="var(--warning)" />
            <rect x="400" y="30" width="60" height="40" rx="9" stroke="var(--border-strong)" />
            <rect x="400" y="120" width="60" height="40" rx="9" stroke="var(--accent)" />
          </g>
        </svg>
        <p className="connect-hero-foot">Every XO is signed and its benchmarks are independently verifiable.</p>
      </div>
      <div className="connect-main">
        <div className="connect-card">
          <p className="brand brand-large">
            <span className="brand-mark" aria-hidden="true" />
            XO Studio
          </p>
          <h1>Sign in</h1>
          <p className="lede">Welcome back. Sign in to continue.</p>
          {props.notice !== undefined ? (
            <div className={`notice notice-${props.notice.tone}`} role={props.notice.tone === 'danger' ? 'alert' : 'status'}>
              <p>{props.notice.text}</p>
            </div>
          ) : null}
          {hasSso || (props.oidcConfiguredButUnavailable && showDev) ? (
            <div className="stack connect-sso">
              <Button variant="secondary" onClick={() => void sso()} disabled={ssoBusy || !hasSso}>
                {ssoBusy ? 'Waiting for your browser…' : 'Continue with Google'}
              </Button>
              {hasSso ? (
                <p className="muted small connect-note">Opens your browser to sign in. Studio never sees your password.</p>
              ) : (
                <p className="muted small connect-note">Google sign-in is available in the XO Studio desktop app.</p>
              )}
              {ssoFailure !== undefined ? (
                <div className="notice notice-danger" role="alert">
                  <p>{ssoFailure.message}</p>
                </div>
              ) : null}
            </div>
          ) : null}
          {showDev && (hasSso || props.oidcConfiguredButUnavailable) ? (
            <p className="connect-or" role="separator">
              <span>or</span>
            </p>
          ) : null}
          {showDev ? (
            <form onSubmit={(e) => void submit(e)} className="stack connect-dev" aria-label="Development sign-in">
              <p className="muted small">
                <strong>Development sign-in</strong> (access key). Not for production use.
              </p>
              <label htmlFor="api-key">Access key</label>
              <input
                id="api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="xoak_…"
                aria-describedby="key-help"
              />
              <p id="key-help" className="muted small">
                Provided by your XO administrator.{' '}
                {shell.capabilities.persistentCredentials
                  ? 'It is stored in this device\u2019s secure credential store until you sign out.'
                  : 'It is kept in this tab only and is forgotten when you close it or sign out.'}
              </p>
              {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
              <Button type="submit" variant="primary" disabled={busy || key.trim().length === 0}>
                {busy ? 'Checking…' : 'Continue'}
              </Button>
              {busy ? <Spinner label="Checking your access key" /> : null}
            </form>
          ) : null}
          {props.oidcConfiguredButUnavailable && !showDev ? (
            <div className="notice notice-danger" role="alert">
              <p>Google sign-in is not yet available in the browser version of Studio. Use the desktop app.</p>
            </div>
          ) : null}
          <p className="muted small connect-legal">Your documents stay yours. XO only acts on what you approve.</p>
        </div>
      </div>
    </main>
  );
}

function Shell() {
  const { signOut } = useSession();
  // Before a workspace is open there is no workspace menu, so Sign out stays reachable here. Inside a workspace it is in the menu.
  const account = (
    <Button variant="quiet" onClick={signOut}>
      Sign out
    </Button>
  );
  return <WorkspaceHome account={account} />;
}
