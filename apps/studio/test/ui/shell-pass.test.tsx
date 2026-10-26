import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { greeting } from '../../src/ui/HomeSection';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { chooseFromMenu, openMenu } from './nav';

async function open(): Promise<ReturnType<typeof userEvent.setup>> {
  const api = new FakeXo();
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops', level: 1 });
  return user;
}
beforeEach(() => window.localStorage.clear());

describe('greeting', () => {
  it('names the day and the part of the day, and never a person', () => {
    expect(greeting(new Date(2026, 9, 19, 9))).toBe('Monday, 19 Oct · Good morning');
    expect(greeting(new Date(2026, 9, 19, 14))).toMatch(/Good afternoon$/);
    expect(greeting(new Date(2026, 9, 19, 21))).toMatch(/Good evening$/);
  });
});

describe('workspace menu', () => {
  it('holds workspace, Settings, detail level and Sign out; Escape closes it and returns focus to the card', async () => {
    const user = await open();
    const menu = await openMenu(user);
    for (const name of ['+ New workspace', 'All workspaces', 'Settings', 'Sign out'])
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitemradio', { name: 'Ops' })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: 'User mode' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Workspace menu' })).toHaveFocus();
  });
  it('Settings opens from it, with General first, and Sign out ends the session', async () => {
    const user = await open();
    await chooseFromMenu(user, 'Settings');
    expect(window.location.hash).toBe('#/settings');
    const tabs = screen.getByRole('tablist', { name: 'Settings sections' });
    expect(within(tabs).getAllByRole('tab')[0]).toHaveTextContent('General');
    await user.click(within(tabs).getByRole('tab', { name: 'Models and runtime' }));
    expect(await screen.findByRole('heading', { name: 'Runtime status' })).toBeInTheDocument();
    expect(await screen.findByText(/Air-gapped mode/)).toBeInTheDocument();
    // Offered only where the platform says it can honour it: the default deployment runs on this machine.
    expect(await screen.findByRole('radio', { name: /Private server/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /This computer/ })).toBeEnabled();
    await chooseFromMenu(user, 'Sign out');
    expect(await screen.findByLabelText(/access key/i)).toBeInTheDocument();
  });
});

describe('sidebar collapse', () => {
  it('collapses to icons on request, keeps every item named, and remembers the choice', async () => {
    const user = await open();
    const app = () => document.querySelector('.app')!;
    expect(app()).toHaveAttribute('data-collapsed', 'false');
    await user.click(screen.getByRole('button', { name: 'Collapse the sidebar to icons' }));
    expect(app()).toHaveAttribute('data-collapsed', 'true');
    expect(screen.getByRole('button', { name: 'Library' })).toBeInTheDocument(); // still named for assistive technology
    expect(window.localStorage.getItem('xo.studio.sidebar')).toBe('collapsed');
    await user.click(screen.getByRole('button', { name: 'Keep the sidebar expanded' }));
    expect(app()).toHaveAttribute('data-collapsed', 'false');
  });
});

describe('Library, Audit log and Home as designed', () => {
  it('Library has the six filters and labels samples; Made by me is empty with no analysis', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Library' }));
    const filters = screen.getByRole('group', { name: 'Filter by area' });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All', 'Insurance', 'Legal', 'Finance', 'Made by me', 'My company']);
    expect(screen.getAllByText('Sample').length).toBe(5);
    await user.click(within(filters).getByRole('button', { name: 'Made by me' }));
    expect(screen.getByText('Nothing matches.')).toBeInTheDocument();
  });
  it('Audit log reads the platform log: filter chips, export as evidence, real Roles and Integrity, no invented retention', async () => {
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Audit log' }));
    const chips = screen.getByRole('group', { name: 'Filter events' });
    expect(within(chips).getByRole('button', { name: 'All events' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(chips).getByRole('button', { name: 'Access denied' })).not.toHaveAttribute('aria-disabled');
    expect(await screen.findByRole('table', { name: 'Audit events' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export evidence (JSON)' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /SOC 2/ })).not.toBeInTheDocument(); // an export is evidence, not a certification
    const side = screen.getByRole('complementary', { name: 'Roles and integrity' });
    expect(await within(side).findByText('Chain intact')).toBeInTheDocument();
    expect(within(side).getByText(/tamper-evident, not tamper-proof/)).toBeInTheDocument();
    expect(within(side).getByText(/no policy has been declared by the operator/)).toBeInTheDocument();
    expect(within(side).queryByText(/\d+ years/)).not.toBeInTheDocument(); // no invented retention
  });
  it('Home shows the date line, and pills only for work that really exists', async () => {
    await open();
    expect(screen.getByText(/ · Good (morning|afternoon|evening)$/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Right now')).not.toBeInTheDocument();
  });
});
