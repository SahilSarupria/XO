import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { chooseFromMenu } from './nav';

async function open(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Claims Ops' });
  return user;
}

describe('app frame', () => {
  it('puts workspace, sections and account controls in the left panel, details on the right', async () => {
    await open(new FakeXo());
    const panel = screen.getByRole('complementary', { name: /xo studio/i });
    expect(within(panel).getByRole('navigation', { name: /workspace sections/i })).toBeInTheDocument();
    // Workspace, Settings, detail level and Sign out are behind the workspace card, not spread over the sidebar.
    expect(within(panel).getByRole('button', { name: 'Workspace menu' })).toHaveAttribute('aria-haspopup', 'menu');
    expect(within(panel).queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('group', { name: /detail level/i })).not.toBeInTheDocument();
    expect(within(panel).queryByLabelText('Workspace')).not.toBeInTheDocument();
    expect(within(panel).queryByRole('main')).not.toBeInTheDocument();
    expect(screen.getByRole('main')).toContainElement(screen.getByRole('heading', { name: 'Claims Ops' }));
  });

  it('marks the current section and every item carries a plain-language hint', async () => {
    const user = await open(new FakeXo());
    const home = screen.getByRole('button', { name: 'Home' });
    expect(home).toHaveAttribute('aria-current', 'page');
    expect(home).toHaveAccessibleDescription(/needs you/i);
    await user.click(screen.getByRole('button', { name: 'Workflows' }));
    expect(screen.getByRole('button', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page');
    expect(home).not.toHaveAttribute('aria-current');
  });

  it('opens the panel from Menu on small screens and closes it after choosing a section', async () => {
    const user = await open(new FakeXo());
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Workflows' }));
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the first-run guide with the real current step, and nothing invented', async () => {
    await open(new FakeXo());
    const guide = screen.getByRole('region', { name: /get started in four steps/i });
    const steps = within(guide).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    expect(steps[0]).toHaveAttribute('aria-current', 'step');
    expect(steps[1]).not.toHaveAttribute('aria-current');
    expect(within(steps[0]!).getByText('Add a document')).toBeInTheDocument();
    // The recommended next action is the same real step, offered once, in Start work.
    const start = screen.getByRole('region', { name: 'Start work' });
    expect(within(start).getByRole('button', { name: 'Add your first document' })).toBeInTheDocument();
  });

  it('names the sidebar sections as designed; Settings is in the workspace menu', async () => {
    await open(new FakeXo());
    const nav = screen.getByRole('navigation', { name: /workspace sections/i });
    const labels = within(nav)
      .getAllByRole('button')
      .filter((b) => b.classList.contains('nav-item'))
      .map((b) => b.querySelector('.nav-label')?.textContent);
    expect(labels).toEqual(['Home', 'Workflows', 'My XOs', 'Inbox', 'Library', 'Activity', 'Audit log']);
  });

  it('shows where you are in the sidebar, with no breadcrumb or mode badge, and keeps the page named for screen readers', async () => {
    const user = await open(new FakeXo());
    expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
    expect(screen.queryByText('User mode')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Claims Ops', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Workflows' }));
    expect(screen.getByRole('button', { name: 'Workflows' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('Workspaces lists the real workspaces, marks the current one, and can start a new one', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await chooseFromMenu(user, 'All workspaces');
    expect(await screen.findByRole('heading', { name: 'Workspaces', level: 2 })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Your workspaces' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Current')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /^open/i })).not.toBeInTheDocument();
    expect(within(list).getByText('Your role:')).toBeInTheDocument();
    expect(within(list).getByText('Members:')).toBeInTheDocument();
    expect(within(list).queryByText('Declared region:')).not.toBeInTheDocument(); // none declared, so nothing is invented
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'New workspace' }));
    expect(await screen.findByLabelText(/workspace name/i)).toBeInTheDocument();
  });

  it('has Inbox and Activity as separate sidebar sections, each keeping the route it always had', async () => {
    const user = await open(new FakeXo());
    await user.click(screen.getByRole('button', { name: /^inbox/i }));
    expect(screen.getByRole('button', { name: /^inbox/i })).toHaveAttribute('aria-current', 'page');
    expect(window.location.hash).toBe('#/tasks');
    await user.click(screen.getByRole('button', { name: 'Activity' }));
    expect(window.location.hash).toBe('#/activity');
    expect(screen.getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: /^inbox/i })).not.toHaveAttribute('aria-current');
  });
});
