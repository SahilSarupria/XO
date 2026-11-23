/**
 * S1-3 — the shell: addresses are paths (old `#/` links redirect, a deep link survives sign-in), a version the Studio does not
 * support stops it calmly, a part the instance does not offer is not asked for, a screen that fails to render recovers and is
 * reported without content, and on a phone a bottom bar holds the four main places and More.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { SECTION_PATH, SECTIONS, pathOf, sectionOf } from '../../src/ui/sectionRoute';
import { PLACES } from '../../src/ui/places';
import { ErrorBoundary } from '../../src/ui/ErrorBoundary';
import { STUDIO_VERSION, supportsApi } from '../../src/platform/build';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { FakeConnect } from '../fakeConnect';
import { openScreen, workspaceReady } from './nav';

type FetchLike = FakeXo['fetch'];

async function signIn(api: FakeXo, fetchImpl: FetchLike = api.fetch) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={fetchImpl} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
}
async function open(api: FakeXo, fetchImpl: FetchLike = api.fetch) {
  const user = await signIn(api, fetchImpl);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  return user;
}
const withVersion =
  (api: FakeXo, body: unknown, seen?: string[]): FetchLike =>
  async (input, init) => {
    seen?.push(input);
    if (input.endsWith('/version'))
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    return api.fetch(input, init);
  };

describe('addresses', () => {
  it('every old #/ link is replaced by its place path, and the path names the same screen', () => {
    for (const s of SECTIONS) {
      const path = pathOf(s, 'ws_1');
      expect(path).toBe(`/w/ws_1/${SECTION_PATH[s]}`);
      expect(sectionOf({ pathname: path, hash: '' })).toBe(s);
      expect(sectionOf({ pathname: '/', hash: `#/${s}` })).toBe(s);
    }
    // Paths are unique, and an unknown one is Home (a path only selects a screen; it grants nothing).
    expect(new Set(Object.values(SECTION_PATH)).size).toBe(SECTIONS.length);
    expect(sectionOf({ pathname: '/w/ws_1/../admin', hash: '' })).toBe('home');
  });

  it('every screen belongs to exactly one of the seven places', () => {
    expect(PLACES.map((p) => p.label)).toEqual(['Home', 'Inbox', 'Work', 'Sources', 'Knowledge', 'Activity', 'Settings']);
    for (const s of SECTIONS) {
      const homes = PLACES.filter((p) => p.views.some((v) => v.section === s) || (p.also ?? []).includes(s));
      expect(
        homes.map((p) => p.id),
        s,
      ).toHaveLength(1);
    }
  });

  it('an old link opened at sign-in lands on its screen at its path; a deep link survives signing in again', async () => {
    window.location.hash = '#/activity';
    const api = new FakeXo();
    const user = await open(api);
    expect(sectionOf(window.location)).toBe('activity');
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toMatch(/^\/w\/[^/]+\/activity$/);
    await openScreen(user, 'Library');
    const deep = window.location.pathname;
    expect(deep).toMatch(/\/work\/library$/);
    cleanup(); // the session ends; the address stays, as it would in the browser
    await signIn(api);
    await workspaceReady('Ops');
    expect(window.location.pathname).toBe(deep);
    expect(screen.getByRole('tab', { name: 'Library' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a link followed inside Studio with an old #/ fragment goes to that screen', async () => {
    await open(new FakeXo());
    window.location.hash = '#/audit';
    await waitFor(() => expect(sectionOf(window.location)).toBe('audit'));
    expect(window.location.pathname).toMatch(/\/activity\/audit$/);
  });
});

describe('version and features (GET /version)', () => {
  it('this Studio supports API 0.1.x only, and STUDIO_VERSION is the package version', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { version: string };
    expect(STUDIO_VERSION).toBe(pkg.version);
    expect(supportsApi('0.1.0')).toBe(true);
    expect(supportsApi('0.1.17')).toBe(true);
    expect(supportsApi('0.2.0')).toBe(false);
    expect(supportsApi('1.1.0')).toBe(false);
    expect(supportsApi('nonsense')).toBe(false);
  });

  it('a version this Studio does not support stops it with a calm message, and nothing else is shown', async () => {
    const api = new FakeXo();
    await signIn(
      api,
      withVersion(api, { version: '0.2.0', features: { connect: true, googleSignIn: false, oidc: false, passwordSignIn: false } }),
    );
    expect(await screen.findByRole('heading', { name: 'XO is being updated', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/needs XO 0\.1, and the service reports 0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Workspace sections' })).not.toBeInTheDocument();
  });

  it('a supported version opens Studio; an instance without Connect is not asked for it', async () => {
    const api = new FakeXo();
    const connect = new FakeConnect(api);
    const seen: string[] = [];
    const user = await open(
      api,
      withVersion(
        api,
        { version: '0.1.4', features: { connect: false, googleSignIn: false, oidc: false, passwordSignIn: false } },
        seen,
      ) as FetchLike,
    );
    void connect;
    await openScreen(user, 'Connect');
    await screen.findByRole('tab', { name: 'Connections', selected: true });
    expect(seen.some((u) => u.endsWith('/version'))).toBe(true);
    expect(seen.filter((u) => /\/api\/connect\//.test(u))).toEqual([]);
  });

  it('an API that cannot say which version it is (older, or unreachable) is used as before', async () => {
    const api = new FakeXo(); // FakeXo has no /version route: a 404
    await open(api);
    expect(screen.getByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument();
  });

  it('asks for the version without sending a credential', async () => {
    const api = new FakeXo();
    const auth: (string | null)[] = [];
    const spy: FetchLike = async (input, init) => {
      if (input.endsWith('/version')) auth.push(new Headers(init?.headers).get('authorization'));
      return api.fetch(input, init);
    };
    await open(api, spy);
    await waitFor(() => expect(auth).toEqual([null]));
  });
});

describe('a screen that fails to render', () => {
  afterEach(() => vi.restoreAllMocks());
  function Broken(): never {
    throw new Error('Cannot read "Asha Rao" of undefined at row 12');
  }
  it('shows a recovery screen with Reload and Home, and reports a template of the error without its content', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reports: [unknown, string | undefined][] = [];
    const home = vi.fn();
    render(
      <ErrorBoundary onError={(e, c) => reports.push([e, c])} onHome={home}>
        <Broken />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('heading', { name: 'Something went wrong on this screen' })).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    within(alert).getByRole('button', { name: 'Go to Home' }).click();
    expect(home).toHaveBeenCalled();
    expect(reports).toHaveLength(1);
    expect(reports[0]![1]).toBe('Broken');
  });

  it('clears when the person goes somewhere else (resetKey)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(
      <ErrorBoundary resetKey="library">
        <Broken />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    view.rerender(
      <ErrorBoundary resetKey="activity">
        <p>Activity</p>
      </ErrorBoundary>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
  });
});

describe('phone bottom bar (under 600 px)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const phone = () =>
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q === '(max-width: 599px)' || q.includes('prefers-color-scheme: dark'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

  it('holds Home, Inbox, Work, Activity and More; More opens every other place and the workspace menu', async () => {
    phone();
    const user = await open(new FakeXo());
    const bar = screen.getByRole('navigation', { name: 'Main places' });
    expect(
      within(bar)
        .getAllByRole('button')
        .map((b) => b.querySelector('.bottom-label')?.textContent),
    ).toEqual(['Home', 'Inbox', 'Work', 'Activity', 'More']);
    expect(within(bar).getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument(); // the drawer button is replaced
    expect(document.documentElement.dataset['bottomBar']).toBe('on');
    await user.click(within(bar).getByRole('button', { name: 'Work' }));
    expect(sectionOf(window.location)).toBe('work');
    const more = within(bar).getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById('sidebar')).toHaveAttribute('data-open', 'true');
    await user.click(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('button', { name: /^Knowledge/ }));
    expect(sectionOf(window.location)).toBe('whatxoknows');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveAttribute('aria-current', 'page'); // Knowledge lives behind More
  });

  it('is not there on a larger screen', async () => {
    await open(new FakeXo());
    expect(screen.queryByRole('navigation', { name: 'Main places' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
  });
});

describe('dark first (D-18)', () => {
  it('index.html starts dark and loads the pre-paint script, which applies a stored light or device choice', () => {
    const html = readFileSync(join(__dirname, '../../index.html'), 'utf8');
    expect(html).toMatch(/<html lang="en" data-theme="dark">/);
    expect(html).toMatch(/<script src="\/theme-boot\.js"><\/script>/);
    const boot = readFileSync(join(__dirname, '../../public/theme-boot.js'), 'utf8');
    const run = () => new Function(boot)() as void;
    window.localStorage.removeItem('xo.studio.theme');
    run();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    window.localStorage.setItem('xo.studio.theme', 'light');
    run();
    expect(document.documentElement.dataset['theme']).toBe('light');
    window.localStorage.setItem('xo.studio.theme', 'system');
    run(); // jsdom has no matchMedia: the device cannot say, so the default stays
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
});
