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

/** The workspace card at the foot of the sidebar opens a menu: switch workspace, Settings, detail level, Sign out. */
export async function openMenu(user: U): Promise<HTMLElement> {
  if (screen.queryByRole('menu', { name: 'Workspace menu' }) === null)
    await user.click(screen.getByRole('button', { name: 'Workspace menu' }));
  return screen.getByRole('menu', { name: 'Workspace menu' });
}
export async function chooseFromMenu(user: U, name: RegExp | string, role: 'menuitem' | 'menuitemradio' = 'menuitem'): Promise<void> {
  await openMenu(user);
  await user.click(screen.getByRole(role, { name }));
}
export const setDetailLevel = (user: U, mode: 'user' | 'builder') =>
  chooseFromMenu(user, mode === 'builder' ? 'Builder mode' : 'User mode', 'menuitemradio');
export const signOutViaMenu = (user: U) => chooseFromMenu(user, 'Sign out');
