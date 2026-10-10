import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { XoClient, type FetchLike } from '../platform/client';

/**
 * Mode is presentation only. It decides how much technical detail is *shown*; it never
 * changes which requests are made, which controls are enabled, or what authority the
 * caller has. Authority comes solely from the API key the backend authenticates.
 */
export type Mode = 'user' | 'builder';

const MODE_KEY = 'xo-studio:mode';

function readMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'builder' ? 'builder' : 'user';
  } catch {
    return 'user';
  }
}

interface SessionValue {
  readonly client: XoClient;
  readonly mode: Mode;
  readonly setMode: (m: Mode) => void;
  readonly signOut: () => void;
}

const SessionContext = createContext<SessionValue | undefined>(undefined);

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (v === undefined) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}

/** Safe outside a session (e.g. the connect screen): technical detail is simply not shown there. */
export function useModeIfAny(): Mode {
  return useContext(SessionContext)?.mode ?? 'user';
}

export function SessionProvider(props: { apiKey: string; fetchImpl?: FetchLike; baseUrl?: string; onSignOut: () => void; children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(readMode);
  const client = useMemo(
    () => new XoClient({ apiKey: props.apiKey, ...(props.fetchImpl !== undefined ? { fetch: props.fetchImpl } : {}), ...(props.baseUrl !== undefined ? { baseUrl: props.baseUrl } : {}) }),
    [props.apiKey, props.fetchImpl, props.baseUrl],
  );
  const value = useMemo<SessionValue>(
    () => ({
      client,
      mode,
      setMode: (m) => {
        setModeState(m);
        try {
          window.localStorage.setItem(MODE_KEY, m);
        } catch {
          /* a preference that cannot be saved is not an error */
        }
      },
      signOut: props.onSignOut,
    }),
    [client, mode, props.onSignOut],
  );
  return <SessionContext.Provider value={value}>{props.children}</SessionContext.Provider>;
}
