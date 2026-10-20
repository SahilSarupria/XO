import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

type U = ReturnType<typeof userEvent.setup>;

/**
 * Opens a screen by the name the tests have always used. The sidebar now follows the design: Workflows / My XOs /
 * Inbox (decisions) / Activity (routes are unchanged).
 */
export async function openScreen(user: U, name: RegExp | string): Promise<void> {
  const n = typeof name === 'string' ? name : ['Work', 'Setup', 'Tasks', 'Activity'].find((l) => name.test(l));
  if (n === 'Work') return user.click(screen.getByRole('button', { name: 'Workflows' }));
  if (n === 'Setup') return user.click(screen.getByRole('button', { name: /^My XOs/ }));
  if (n === 'Tasks') return user.click(screen.getByRole('button', { name: /^Inbox/ }));
  if (n === 'Activity') return user.click(screen.getByRole('button', { name: 'Activity' }));
  return user.click(screen.getByRole('button', { name }));
}
