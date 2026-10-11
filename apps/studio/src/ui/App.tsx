import { useCallback, useState, type FormEvent } from 'react';
import { XoClient, type ApiProblem, type FetchLike } from '../platform/client';
import { Button, ProblemNotice, Spinner } from './primitives';
import { SessionProvider, useSession } from './session';
import { WorkspaceHome } from './WorkspaceHome';

export interface AppProps {
  /** Test seam: lets tests inject a fake transport. Production uses the browser's fetch. */
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
}

/**
 * The key lives in this component's memory only. It is never written to
 * localStorage/sessionStorage/cookies, and it is dropped on sign-out or reload.
 * That is a deliberate limit of API-key auth (see STUDIO_ARCHITECTURE.md §7): a
 * durable human login needs a backend session mechanism that does not exist yet.
 */
export function App(props: AppProps) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const signOut = useCallback(() => setApiKey(null), []);

  if (apiKey === null) return <ConnectScreen {...props} onConnected={setApiKey} />;
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

function ConnectScreen(props: AppProps & { onConnected: (key: string) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | undefined>();

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
            Provided by your XO administrator. It is kept in this tab only and is forgotten when you close it or sign out.
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
