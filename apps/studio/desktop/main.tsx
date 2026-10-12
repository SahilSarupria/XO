// UNVERIFIED SCAFFOLDING: not typechecked or run (requires @tauri-apps/* installed; see docs/studio/DESKTOP.md).
// The only place Tauri APIs are imported. Shared UI in ../src never imports them.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { App } from '../src/ui/App';
import { ConfigError } from '../src/shell/ConfigError';
import { resolveApiBaseUrl } from '../src/shell/config';
import { ShellProvider, type ShellServices } from '../src/shell/services';
import '../src/styles/tokens.css';
import '../src/styles/app.css';

const services: ShellServices = {
  kind: 'desktop',
  capabilities: { persistentCredentials: true },
  credentials: {
    load: () => invoke<string | null>('credential_load'),
    save: (secret) => invoke<void>('credential_save', { secret }),
    clear: () => invoke<void>('credential_clear'),
  },
};

async function start() {
  const root = document.getElementById('root');
  if (root === null) throw new Error('Studio root element missing');
  const r = createRoot(root);
  try {
    // The shell, not a hard-coded URL, supplies the API address. A packaged app has no
    // dev proxy, so it must be an absolute http(s) address (validated again natively).
    const cfg = await invoke<{ apiBaseUrl: string | null }>('shell_config');
    const resolved = resolveApiBaseUrl({ runtime: { apiBaseUrl: cfg.apiBaseUrl ?? undefined } });
    if (!resolved.ok) return r.render(<ConfigError message={resolved.message} />);
    if (resolved.baseUrl.startsWith('/')) {
      return r.render(
        <ConfigError message="The desktop app needs a full API address (https://…). Set XO_API_URL or the shell config file, then restart." />,
      );
    }
    r.render(
      <StrictMode>
        <ShellProvider services={services}>
          <App baseUrl={resolved.baseUrl} fetchImpl={(input, init) => tauriFetch(input, init)} />
        </ShellProvider>
      </StrictMode>,
    );
  } catch {
    r.render(<ConfigError message="The desktop shell could not read its configuration." />);
  }
}
void start();
