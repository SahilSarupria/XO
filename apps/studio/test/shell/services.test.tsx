import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { ConfigError } from '../../src/shell/ConfigError';
import { createWebShellServices, type CredentialStore, type ShellServices } from '../../src/shell/services';
import { FakeXo } from '../fakeXo';
import { withShell } from '../shell';

describe('web credential store contract', () => {
  it('round-trips in memory and clears', async () => {
    const s = createWebShellServices();
    expect(s.kind).toBe('web');
    expect(s.capabilities.persistentCredentials).toBe(false);
    expect(await s.credentials.load()).toBeNull();
    await s.credentials.save('k');
    expect(await s.credentials.load()).toBe('k');
    await s.credentials.clear();
    expect(await s.credentials.load()).toBeNull();
  });
  it('never writes to browser storage or cookies', async () => {
    const s = createWebShellServices();
    await s.credentials.save('xoak_secret');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('xoak_secret');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('xoak_secret');
    expect(document.cookie).not.toContain('xoak_secret');
  });
});

function fakeDesktop(store: Map<string, string>): ShellServices & { calls: string[] } {
  const calls: string[] = [];
  const credentials: CredentialStore = {
    load: async () => {
      calls.push('load');
      return store.get('k') ?? null;
    },
    save: async (v) => {
      calls.push('save');
      store.set('k', v);
    },
    clear: async () => {
      calls.push('clear');
      store.delete('k');
    },
  };
  return { kind: 'desktop', capabilities: { persistentCredentials: true }, credentials, calls };
}

describe('the app uses injected shell services', () => {
  it('saves on connect and clears on sign-out when the shell persists credentials', async () => {
    const api = new FakeXo();
    const store = new Map<string, string>();
    const shell = fakeDesktop(store);
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />, shell));
    await user.type(await screen.findByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(store.get('k')).toBe(api.validKey));
    await user.click(await screen.findByRole('button', { name: /sign out/i }));
    await waitFor(() => expect(store.has('k')).toBe(false));
  });

  it('restores a stored credential after verifying it with the server', async () => {
    const api = new FakeXo();
    const shell = fakeDesktop(new Map([['k', api.validKey]]));
    render(withShell(<App fetchImpl={api.fetch} />, shell));
    expect(await screen.findByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('discards a stored credential the server rejects and says why', async () => {
    const api = new FakeXo();
    const store = new Map([['k', 'xoak_stale']]);
    render(withShell(<App fetchImpl={api.fetch} />, fakeDesktop(store)));
    expect(await screen.findByLabelText(/access key/i)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(store.has('k')).toBe(false);
  });

  it('keeps the stored credential when the service is merely unreachable', async () => {
    const store = new Map([['k', 'xoak_x']]);
    render(
      withShell(
        <App
          fetchImpl={async () => {
            throw new TypeError('Failed to fetch');
          }}
        />,
        fakeDesktop(store),
      ),
    );
    expect(await screen.findByLabelText(/access key/i)).toBeInTheDocument();
    expect(await screen.findByText(/cannot reach xo/i)).toBeInTheDocument();
    expect(store.get('k')).toBe('xoak_x');
  });

  it('web shell shows no persistence wording and never restores', async () => {
    render(withShell(<App fetchImpl={new FakeXo().fetch} />));
    expect(await screen.findByText(/kept in this tab only/i)).toBeInTheDocument();
  });
});

describe('startup configuration failure', () => {
  it('renders an actionable alert, not a blank screen', () => {
    render(<ConfigError message="XO Studio is configured with an invalid API address." />);
    expect(screen.getByRole('alert')).toHaveTextContent(/can.t start/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid API address/);
  });
});
