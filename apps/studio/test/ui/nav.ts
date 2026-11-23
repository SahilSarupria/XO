import { screen, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';

type U = ReturnType<typeof userEvent.setup>;

/**
 * Opens a screen by the name the tests have always used. S1-3: the sidebar has seven places (Home, Inbox, Work, Sources,
 * Knowledge, Activity, Settings); screens that used to be sidebar items are tabs inside a place now.
 */
const PLACE_OF: Record<string, readonly [RegExp, string?]> = {
  Work: [/^Work(?![a-z])/],
  Workflows: [/^Work(?![a-z])/],
  Setup: [/^Sources/],
  'My XOs': [/^Sources/],
  Sources: [/^Sources/],
  Tasks: [/^Inbox/],
  Inbox: [/^Inbox/],
  Activity: [/^Activity/],
  Home: [/^Home/],
  Settings: [/^Settings/],
  Library: [/^Work(?![a-z])/, 'Library'],
  Processes: [/^Work(?![a-z])/, 'Processes'],
  Connect: [/^Sources/, 'Connections'],
  Contracts: [/^Sources/, 'Contracts'],
  'What XO knows': [/^Knowledge/],
  Knowledge: [/^Knowledge/, 'Records'],
  'Audit log': [/^Activity/, 'Audit log'],
  Platform: [/^Settings/, 'Platform'],
  Workspaces: [/^Settings/, 'All workspaces'],
};
export async function openScreen(user: U, name: RegExp | string): Promise<void> {
  const n = typeof name === 'string' ? name : Object.keys(PLACE_OF).find((l) => name.test(l));
  const target = n === undefined ? undefined : PLACE_OF[n];
  if (target === undefined) return user.click(screen.getByRole('button', { name }));
  await user.click(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('button', { name: target[0] }));
  if (target[1] !== undefined) await user.click(await screen.findByRole('tab', { name: target[1] }));
}

/** The workspace card at the foot of the sidebar opens a menu: switch workspace, Settings, detail level, Sign out. */
export async function openMenu(user: U): Promise<HTMLElement> {
  if (screen.queryByRole('menu', { name: /workspace menu/i }) === null)
    await user.click(screen.getByRole('button', { name: /workspace menu/i }));
  return screen.getByRole('menu', { name: /workspace menu/i });
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
  return screen.findByRole('button', { name: /start this workflow/i });
}
export async function findViewGraph(user: U): Promise<HTMLElement> {
  await openWorkflow(user);
  return screen.findByRole('button', { name: /view graph of/i });
}

/**
 * S1-3: a page's h1 is the place's name now; the workspace's name is on the sidebar card (the workspace menu button). Waits for
 * the workspace to be open by finding that card.
 */
const cardName = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} Connected`);
export const workspaceReady = (name = 'Ops'): Promise<HTMLElement> => screen.findByRole('button', { name: cardName(name) });
export const workspaceCard = (name = 'Ops'): HTMLElement => screen.getByRole('button', { name: cardName(name) });
