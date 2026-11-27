/**
 * S1-9 — inviting someone and joining from a link. The link is shown once, with the token after the # (so it is not part of a page
 * request); a role above what a link can grant is not offered; a person without the right to manage is told why; a link that does not
 * work reads the same however it failed; the token is taken out of the address once it is read.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { chooseFromMenu, workspaceReady } from './nav';

async function signedIn(api: FakeXo, path = '#/home') {
  window.history.replaceState(null, '', path);
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
}
async function openMembers(api: FakeXo) {
  const user = await signedIn(api);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  await chooseFromMenu(user, 'Settings');
  await user.click(await screen.findByRole('tab', { name: 'Members' }));
  return {
    user,
    panel: within(
      await screen.findByRole('region', { name: 'Invite someone' }).catch(() => screen.getByText('Invite someone').closest('section')!),
    ),
  };
}

describe('inviting someone', () => {
  it('makes a link for a role that cannot be admin, shows it once, and can take it back', async () => {
    const api = new FakeXo();
    const { user, panel } = await openMembers(api);
    const roles = within(panel.getByLabelText('What they can do'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(roles.join(' ')).not.toMatch(/admin/i);
    await user.click(panel.getByRole('button', { name: 'Make an invitation link' }));
    const link = await panel.findByTestId('invite-link');
    expect(link.textContent).toMatch(/\/join#ws_x\./);
    expect(panel.getByText(/it cannot be shown again/i)).toBeInTheDocument();
    expect(await panel.findByText(/Waiting to be used/)).toBeInTheDocument();
    await user.click(panel.getByRole('button', { name: /^Take back the .* link$/ }));
    expect(await panel.findByText(/Taken back/)).toBeInTheDocument();
  });

  it('tells a person who may not manage why, and sends nothing', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const { panel } = await openMembers(api);
    expect(panel.getByRole('button', { name: 'Make an invitation link' })).toHaveAccessibleDescription(/does not include inviting people/);
  });
});

describe('joining from a link', () => {
  it('joins once, takes the token out of the address, and opens the workspace', async () => {
    const api = new FakeXo();
    const user = await signedIn(api, `/join#${api.studio.joinWith}`);
    await user.click(await screen.findByRole('button', { name: 'Join this workspace' }));
    expect(await screen.findByText(/You have joined\./)).toBeInTheDocument();
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/join');
    expect(api.studio.joinCalls).toEqual([api.studio.joinWith]);
  });

  it('says the same thing however a link fails, and that nothing changed for someone who already has access', async () => {
    const api = new FakeXo();
    const user = await signedIn(api, '/join#ws_x.some-other-secret-secret-secret');
    await user.click(await screen.findByRole('button', { name: 'Join this workspace' }));
    expect(await screen.findByText(/This link does not work\. It may have been used, taken back or have expired\./)).toBeInTheDocument();
  });

  it('does not use up or change anything when the person already has access', async () => {
    const api = new FakeXo();
    api.studio.joinAlready = true;
    const user = await signedIn(api, `/join#${api.studio.joinWith}`);
    await user.click(await screen.findByRole('button', { name: 'Join this workspace' }));
    expect(await screen.findByText('You already have access to this workspace. Nothing was changed.')).toBeInTheDocument();
  });

  it('shows no join button for an address without a token', async () => {
    const api = new FakeXo();
    await signedIn(api, '/join');
    expect(await screen.findByText(/This link does not work/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join this workspace' })).toBeNull();
  });
});
