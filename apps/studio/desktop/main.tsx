// UNVERIFIED SCAFFOLDING: not typechecked or run (requires @tauri-apps/* installed; see docs/studio/DESKTOP.md).
// The only place Tauri APIs are imported. Shared UI in ../src never imports them.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { App } from '../src/ui/App';
import { ConfigError } from '../src/shell/ConfigError';
import { isSecureOrLoopbackUrl } from '../src/auth/oidc';
import { resolveApiBaseUrl, resolveAuthConfig } from '../src/shell/config';
import { CredentialStoreError, ShellProvider, type ShellServices } from '../src/shell/services';
import type { SystemBrowserLogin } from '../src/auth/oidcSession';
import '../src/styles/tokens.css';
import '../src/styles/app.css';

/** Native errors are fixed codes ("unavailable" | "invalid"); anything else is treated as unavailable. */
async function native<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new CredentialStoreError(e === 'invalid' ? 'invalid' : 'unavailable', 'native command failed');
  }
}

const login: SystemBrowserLogin = {
  begin: async () => ({ redirectUri: await native<string>('login_begin') }),
  openBrowser: (url) => native<void>('open_system_browser', { url }),
  awaitCallback: () => native<string>('login_await'),
};

const services: ShellServices = {
  kind: 'desktop',
  capabilities: { persistentCredentials: true, systemBrowserLogin: true },
  login,
  credentials: {
    load: () => native<string | null>('credential_load'),
    save: (secret) => native<void>('credential_save', { secret }),
    clear: () => native<void>('credential_clear'),
  },
};

interface NativeConfig {
  apiBaseUrl: string | null;
  oidc: { issuer: string; clientId: string; audience?: string } | null;
  devSignIn: boolean;
  configError: string | null;
}

async function start() {
  const root = document.getElementById('root');
  if (root === null) throw new Error('Studio root element missing');
  const r = createRoot(root);
  const fail = (message: string) => r.render(<ConfigError message={message} />);
  let cfg: NativeConfig;
  try {
    cfg = await invoke<NativeConfig>('shell_config');
  } catch {
    return fail('The desktop shell could not read its configuration.');
  }
  // The shell, not a hard-coded URL, supplies every address. Invalid values stop startup.
  if (cfg.configError !== null) return fail(`The desktop shell is misconfigured: ${cfg.configError}.`);
  const api = resolveApiBaseUrl({ runtime: { apiBaseUrl: cfg.apiBaseUrl ?? undefined } });
  if (!api.ok) return fail(api.message);
  // No dev proxy in a packaged app: the API must be an absolute https (or loopback) address.
  if (api.source === 'default' || api.baseUrl.startsWith('/') || !isSecureOrLoopbackUrl(new URL(api.baseUrl))) {
    return fail(
      'The desktop app needs an https API address. Set XO_API_URL (a loopback http address is allowed for local development), then restart.',
    );
  }
  const auth = resolveAuthConfig({ ...(cfg.oidc !== null ? { oidc: cfg.oidc } : {}), devSignIn: cfg.devSignIn });
  if (!auth.ok) return fail(auth.message);

  r.render(
    <StrictMode>
      <ShellProvider services={services}>
        <App
          baseUrl={api.baseUrl}
          devSignIn={auth.devSignIn}
          {...(auth.oidc !== undefined ? { oidc: auth.oidc } : {})}
          // One transport for the API AND the identity provider: both go through the native HTTP
          // plugin, so both are subject to the capability allow-list (no CORS, no CSP widening).
          fetchImpl={(input, init) => tauriFetch(input, init)}
        />
      </ShellProvider>
    </StrictMode>,
  );
}
void start();
