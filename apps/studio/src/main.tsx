import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { ConfigError } from './shell/ConfigError';
import { resolveFromEnvironment } from './shell/config';
import { ShellProvider, createWebShellServices } from './shell/services';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Studio root element missing');

// A desktop shell replaces createWebShellServices() with its own implementation (see
// docs/studio/DESKTOP.md). Shared UI never imports native APIs.
const config = resolveFromEnvironment();
createRoot(root).render(
  <StrictMode>
    {config.ok ? (
      <ShellProvider services={createWebShellServices()}>
        <App baseUrl={config.baseUrl} />
      </ShellProvider>
    ) : (
      <ConfigError message={config.message} />
    )}
  </StrictMode>,
);
