import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { XoClient, type ApiProblem, type FetchLike } from '../platform/client';
import { Button, ProblemNotice, Spinner } from './primitives';
import { SessionProvider, useSession } from './session';
import { WorkspaceHome } from './WorkspaceHome';
import { useShell } from '../shell/services';

export interface AppProps {
  /** Test seam: lets tests inject a fake transport. Production uses the browser's fetch. */
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
}

/**
 * The credential is held in this component's memory and, only when the shell reports
 * `persistentCredentials`, in the shell's credential store (an OS keychain on desktop).
 * The web shell never persists it: not in localStorage, sessionStorage or cookies. It is
 * dropped on sign-out. That is a deliberate limit of access-key sign-in (a development
 * mechanism; see docs/studio/AUTH_DECISION.md).
 */
export function App(props: AppProps) {
  const shell = useShell();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(shell.capabilities.persistentCredentials);
  const [restoreProblem, setRestoreProblem] = useState<ApiProblem | undefined>();

  // Restore a stored credential (desktop only). It is verified with a real call; a stale
  // or revoked credential is cleared and the sign-in form is shown with the reason.
  useEffect(() => {
    if (!shell.capabilities.persistentCredentials) return;
    let live = true;
    void (async () => {
      try {
        const stored = await shell.credentials.load();
        if (stored === null) return;
        const probe = new XoClient({
          apiKey: stored,
          ...(props.fetchImpl !== undefined ? { fetch: props.fetchImpl } : {}),
          ...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {}),
        });
        const r = await probe.listWorkspaces();
        if (!live) return;
        if (r.ok) setApiKey(stored);
        else {
          setRestoreProblem(r.problem);
          // Only discard the credential when the server rejected it, never on a network blip.
          if (r.problem.kind !== 'network') await shell.credentials.clear();
        }
      } catch {
        // Credential store unavailable: fall through to manual sign-in.
      } finally {
        if (live) setRestoring(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [shell, props.fetchImpl, props.baseUrl]);

  const signOut = useCallback(() => {
    setApiKey(null);
    void shell.credentials.clear().catch(() => undefined);
  }, [shell]);

  const connected = useCallback(
    (key: string) => {
      setApiKey(key);
      if (shell.capabilities.persistentCredentials) void shell.credentials.save(key).catch(() => undefined);
    },
    [shell],
  );

  if (restoring) return <Spinner label="Reconnecting to XO" />;
  if (apiKey === null) {
    return (
      <ConnectScreen {...props} onConnected={connected} {...(restoreProblem !== undefined ? { initialProblem: restoreProblem } : {})} />
    );
  }
  return (
    <SessionProvider
      apiKey={apiKey}
      onSignOut={signOut}
      {...(props.fetchImpl !== undefined ? { fetchImpl: props.fetchImpl } : {})}
      {...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {})}
    >
      <Shell />
    </SessionProvider>
  );
}

function ConnectScreen(props: AppProps & { onConnected: (key: string) => void; initialProblem?: ApiProblem }) {
  const shell = useShell();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>(props.initialProblem);

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

  return (
    <main className="connect">
      <div className="connect-card">
        <p className="brand brand-large">
          <span className="brand-mark" aria-hidden="true" />
          XO Studio
        </p>
        <h1>Turn your organisation&rsquo;s documents into rules you can trust.</h1>
        <p className="lede">
          Upload what you already have. XO finds the rules inside, shows you the evidence, and only acts on what you approve.
        </p>
        <form onSubmit={(e) => void submit(e)} className="stack">
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
            Provided by your XO administrator (development sign-in).{' '}
            {shell.capabilities.persistentCredentials
              ? 'It is stored in this device\u2019s secure credential store until you sign out.'
              : 'It is kept in this tab only and is forgotten when you close it or sign out.'}
          </p>
          {problem !== undefined ? <ProblemNotice problem={problem} /> : null}
          <Button type="submit" variant="primary" disabled={busy || key.trim().length === 0}>
            {busy ? 'Checking…' : 'Connect'}
          </Button>
          {busy ? <Spinner label="Checking your access key" /> : null}
        </form>
      </div>
    </main>
  );
}

function Shell() {
  const { mode, setMode, signOut } = useSession();
  return (
    <div className="shell">
      <header className="topbar">
        <p className="brand">
          <span className="brand-mark" aria-hidden="true" />
          XO Studio
        </p>
        <div className="topbar-right">
          <div className="mode" role="group" aria-label="Detail level">
            <button type="button" aria-pressed={mode === 'user'} onClick={() => setMode('user')}>
              Standard
            </button>
            <button type="button" aria-pressed={mode === 'builder'} onClick={() => setMode('builder')}>
              Builder
            </button>
          </div>
          <Button variant="quiet" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </header>
      <WorkspaceHome />
    </div>
  );
}
