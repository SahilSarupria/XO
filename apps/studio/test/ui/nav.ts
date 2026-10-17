import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

type U = ReturnType<typeof userEvent.setup>;

/**
 * Opens a screen by the name the tests have always used. The sidebar now says Workflows / Sources / Runs & History
 * (routes are unchanged); Activity is a tab inside Runs & History.
 */
export async function openScreen(user: U, name: RegExp | string): Promise<void> {
  const n = typeof name === 'string' ? name : ['Work', 'Setup', 'Tasks', 'Activity'].find((l) => name.test(l));
  if (n === 'Work') return user.click(screen.getByRole('button', { name: 'Workflows' }));
  if (n === 'Setup') return user.click(screen.getByRole('button', { name: /^Sources/ }));
  if (n === 'Tasks') return user.click(screen.getByRole('button', { name: /^Runs & History/ }));
  if (n === 'Activity') {
    if (screen.queryByRole('button', { name: 'Activity' }) === null) {
      await user.click(screen.getByRole('button', { name: /^Runs & History/ }));
    }
    return user.click(screen.getByRole('button', { name: 'Activity' }));
  }
  return user.click(screen.getByRole('button', { name }));
}
