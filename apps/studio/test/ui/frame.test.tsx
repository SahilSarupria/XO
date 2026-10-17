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
    await user.click(screen.getByRole('button', { name: 'Work' }));
    expect(screen.getByRole('button', { name: 'Work' })).toHaveAttribute('aria-current', 'page');
    expect(home).not.toHaveAttribute('aria-current');
  });

  it('opens the panel from Menu on small screens and closes it after choosing a section', async () => {
    const user = await open(new FakeXo());
    const menu = screen.getByRole('button', { name: /menu/i });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Work' }));
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
    expect(within(guide).getByText('Add your first document')).toBeInTheDocument();
  });
});
