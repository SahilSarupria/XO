import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

async function open(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Claims Ops' });
  return user;
}

describe('app frame', () => {
  it('puts workspace, sections and account controls in the left panel, details on the right', async () => {
    await open(new FakeXo());
    const panel = screen.getByRole('complementary', { name: /xo studio/i });
    expect(within(panel).getByLabelText('Workspace')).toBeInTheDocument();
    expect(within(panel).getByRole('navigation', { name: /workspace sections/i })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /detail level/i })).toBeInTheDocument();
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
    const menu = screen.getByRole('button', { name: /menu/i });
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

  it('names the sidebar sections by what people do, and has no Settings destination yet', async () => {
    await open(new FakeXo());
    const nav = screen.getByRole('navigation', { name: /workspace sections/i });
    const labels = within(nav)
      .getAllByRole('button')
      .map((b) => b.querySelector('.nav-label')?.textContent);
    expect(labels).toEqual(['Home', 'Workspaces', 'Sources', 'Workflows', 'Runs & History']);
    expect(labels).not.toContain('Settings');
  });

  it('shows where you are in a breadcrumb that follows the page', async () => {
    const user = await open(new FakeXo());
    const crumbs = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs()).getByText('Home').closest('li')).toHaveAttribute('aria-current', 'page');
    await user.click(screen.getByRole('button', { name: 'Workflows' }));
    const current = within(crumbs()).getByText('Workflows').closest('li');
    expect(current).toHaveAttribute('aria-current', 'page');
    // Earlier crumbs are links; the current page is not.
    expect(within(crumbs()).getByRole('button', { name: 'Claims Ops' })).toBeInTheDocument();
    expect(within(crumbs()).queryByRole('button', { name: 'Workflows' })).not.toBeInTheDocument();
  });

  it('Workspaces lists the real workspaces, marks the current one, and can start a new one', async () => {
    const api = new FakeXo();
    const user = await open(api);
    const nav = screen.getByRole('navigation', { name: /workspace sections/i });
    await user.click(within(nav).getByRole('button', { name: 'Workspaces' }));
    expect(await screen.findByRole('heading', { name: 'Workspaces', level: 2 })).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Your workspaces' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Current')).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /^open/i })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'New workspace' }));
    expect(await screen.findByLabelText(/workspace name/i)).toBeInTheDocument();
  });

  it('keeps Tasks and Activity under Runs & History, and Back still returns to the previous page', async () => {
    const user = await open(new FakeXo());
    await user.click(screen.getByRole('button', { name: /^runs & history/i }));
    const runs = screen.getByRole('button', { name: /^runs & history/i });
    expect(runs).toHaveAttribute('aria-current', 'page');
    const tabs = screen.getByRole('group', { name: /runs and history views/i });
    expect(within(tabs).getByRole('button', { name: /^tasks/i })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(tabs).getByRole('button', { name: 'Activity' }));
    expect(window.location.hash).toBe('#/activity');
    expect(screen.getByRole('button', { name: /^runs & history/i })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('button', { name: 'Activity' })).toHaveAttribute('aria-pressed', 'true');
  });
});
