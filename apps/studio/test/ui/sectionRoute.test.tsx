import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { parseSection } from '../../src/ui/sectionRoute';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

async function connectToWorkspace(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Claims Ops' });
  return user;
}

describe('parseSection', () => {
  it('accepts known sections and falls back to home for anything else', () => {
    expect(parseSection('#/work')).toBe('work');
    expect(parseSection('#tasks')).toBe('tasks');
    expect(parseSection('')).toBe('home');
    expect(parseSection('#/../admin')).toBe('home');
  });
});

describe('section in the URL', () => {
  it('records the section, and Back returns to the previous one', async () => {
    const user = await connectToWorkspace(new FakeXo());
    await user.click(screen.getByRole('button', { name: /^workflows/i }));
    expect(window.location.hash).toBe('#/work');
    await user.click(screen.getByRole('button', { name: /^inbox/i }));
    expect(window.location.hash).toBe('#/tasks');
    window.history.back();
    await screen.findByRole('heading', { name: /^workflows$/i });
    expect(screen.getByRole('button', { name: /^workflows/i })).toHaveAttribute('aria-current', 'page');
  });

  it('does not expose the builder-only section in Standard mode, even by URL', async () => {
    window.location.hash = '#/processes';
    await connectToWorkspace(new FakeXo());
    expect(screen.queryByRole('button', { name: /^processes/i })).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#/home');
  });
});
