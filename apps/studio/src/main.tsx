import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ConfigError } from './shell/ConfigError';
import { resolveAuthConfig, resolveFromEnvironment } from './shell/config';
import { ShellProvider, createWebShellServices } from './shell/services';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Studio root element missing');

// A desktop shell replaces createWebShellServices() with its own implementation (see
// docs/studio/DESKTOP.md). Shared UI never imports native APIs.
const config = resolveFromEnvironment();
const authConfig = resolveAuthConfig(window.__XO_CONFIG__);
createRoot(root).render(
  <StrictMode>
    {!config.ok ? (
      <ConfigError message={config.message} />
    ) : !authConfig.ok ? (
      <ConfigError message={authConfig.message} />
    ) : (
      <ShellProvider services={createWebShellServices()}>
        <App
          baseUrl={config.baseUrl}
          devSignIn={authConfig.devSignIn}
          {...(authConfig.oidc !== undefined ? { oidc: authConfig.oidc } : {})}
        />
      </ShellProvider>
    )}
  </StrictMode>,
);
