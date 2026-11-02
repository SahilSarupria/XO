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

/**
 * On the Workflows page a workflow is a card; its details (and the Start button) are in a panel that opens when the
 * card is chosen. Opens the first workflow's panel if it is not open yet, then returns the Start/continue controls.
 */
export async function openWorkflow(user: U): Promise<void> {
  if (screen.queryByRole('dialog') !== null) return;
  const title = await waitForTitle();
  await user.click(title);
  await screen.findByRole('dialog');
}
async function waitForTitle(): Promise<HTMLElement> {
  for (let i = 0; i < 100; i++) {
    const el = document.querySelector<HTMLElement>('[data-wf-open]');
    if (el !== null) return el;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('No workflow card appeared');
}
export async function findStart(user: U): Promise<HTMLElement> {
  await openWorkflow(user);
  return screen.findByRole('button', { name: /start this process/i });
}
export async function findViewGraph(user: U): Promise<HTMLElement> {
  await openWorkflow(user);
  return screen.findByRole('button', { name: /view graph of/i });
}
