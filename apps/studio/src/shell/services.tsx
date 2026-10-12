import { createContext, useContext, type ReactNode } from 'react';

/**
 * The only seam between shared UI and anything native. Shared code depends on this
 * interface; a desktop shell supplies its own implementation. No Tauri import may
 * appear outside src/shell/desktop*.
 *
 * Nothing here holds business state: runs, decisions, notes and approvals live on
 * the server.
 */
export type ShellKind = 'web' | 'desktop';

export interface ShellCapabilities {
  /** True only when the shell can keep a credential in an OS-protected store across launches. */
  readonly persistentCredentials: boolean;
}

export interface CredentialStore {
  load(): Promise<string | null>;
  save(secret: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ShellServices {
  readonly kind: ShellKind;
  readonly credentials: CredentialStore;
  readonly capabilities: ShellCapabilities;
}

/**
 * Web credential store: memory only. The secret is never written to localStorage,
 * sessionStorage, cookies or the URL, and is gone on reload. (Durable web sign-in
 * needs the server-side session mechanism discussed in the auth decision document.)
 */
export function createWebShellServices(): ShellServices {
  let secret: string | null = null;
  return {
    kind: 'web',
    capabilities: { persistentCredentials: false },
    credentials: {
      load: () => Promise.resolve(secret),
      save: (s) => {
        secret = s;
        return Promise.resolve();
      },
      clear: () => {
        secret = null;
        return Promise.resolve();
      },
    },
  };
}

const ShellContext = createContext<ShellServices | null>(null);

export function ShellProvider(props: { readonly services: ShellServices; readonly children: ReactNode }) {
  return <ShellContext.Provider value={props.services}>{props.children}</ShellContext.Provider>;
}

export function useShell(): ShellServices {
  const s = useContext(ShellContext);
  if (s === null) throw new Error('useShell must be used inside <ShellProvider>');
  return s;
}
