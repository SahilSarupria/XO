import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { FakeSources } from '../fakeSources';
import { agentCommands, syncReportLines } from '../../src/domain/sourceConnections';
import { openScreen, workspaceReady } from './nav';

async function open(sources: FakeSources, api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={sources.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Renewals Desk');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Renewals Desk');
  await openScreen(user, 'Connect');
  await screen.findByRole('heading', { name: 'Folders and drives' });
  return user;
}
const setup = () => {
  const api = new FakeXo();
  return { api, sources: new FakeSources(api.fetch) };
};

describe('Connect: the workspace’s folders and drives (UW-12a)', () => {
  it('offers only what this instance can connect, and says why the rest is missing', async () => {
    const { api, sources } = setup();
    await open(sources, api);
    expect(screen.getByText('Nothing is connected to this workspace yet.')).toBeInTheDocument();
    const add = screen.getByRole('group', { name: 'Connect a folder or drive' });
    expect(within(add).getByRole('button', { name: "Connect a computer's folder" })).toBeInTheDocument();
    expect(within(add).getByRole('button', { name: 'Connect Google Drive' })).toBeInTheDocument();
    expect(within(add).queryByRole('button', { name: /OneDrive/ })).toBeNull();
    expect(within(add).getByText(/OneDrive or SharePoint is not set up on this XO instance yet/)).toBeInTheDocument();
    expect(within(add).queryByRole('button', { name: /server folder/ })).toBeNull(); // no XO_SOURCE_FOLDER_ROOTS here
    // The personal Connect service is not served by this instance, so its screens (and their errors) do not show.
    expect(screen.queryByText(/connect your first source/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a folder on a computer: a one-time code and the exact commands; the page carries on by itself once the agent pairs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api, sources } = setup();
      const user = await open(sources, api);
      await user.click(screen.getByRole('button', { name: "Connect a computer's folder" }));
      await user.click(screen.getByRole('button', { name: 'Get a pairing code' }));
      const steps = await screen.findByRole('region', { name: 'Pair the computer' });
      expect(within(steps).getByText('ABCD-EFGH-JKMN-PQ21')).toBeInTheDocument();
      expect(
        within(steps).getByText('xo agent pair --server https://xo.acme.example --code ABCD-EFGH-JKMN-PQ21 --folder "<the folder>"'),
      ).toBeInTheDocument();
      expect(within(steps).getByText('xo agent install')).toBeInTheDocument();
      expect(screen.getByText('Waiting for the computer to pair.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull(); // nothing to sync until it pairs
      expect(sources.calls.find((c) => c.method === 'POST' && c.path.endsWith('/source-connections'))?.body).toEqual({
        kind: 'agent_folder',
      });

      sources.agentPairs(sources.connections[0]!['connectionId'] as string);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_100);
      });
      expect(await screen.findByRole('heading', { name: 'Renewals' })).toBeInTheDocument();
      expect(screen.getByText(/Paired with “office-pc”/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Pair the computer' })).toBeNull(); // the code is gone once used
      expect(screen.getByText('Left out, never read: 1 hidden files.')).toBeInTheDocument();
      expect(screen.getByText(/sends changes a few seconds after they happen/)).toBeInTheDocument();

      // Sync now is a request the agent picks up; pairing again gives a new code.
      await user.click(screen.getByRole('button', { name: 'Sync now' }));
      expect(await screen.findByText(/A sync has been asked for; the agent picks it up within a minute/)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Pair a different computer' }));
      await waitFor(() => expect(sources.calls.some((c) => c.path.endsWith('/agent/pair'))).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a drive: connect an account (read-only), choose a folder by browsing, then confirm what XO found', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api, sources } = setup();
      const user = await open(sources, api);
      await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
      await user.click(await screen.findByRole('button', { name: 'Connect a Google account' }));
      const link = await screen.findByRole('link', { name: 'Open Google to allow read-only access' });
      expect(link).toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/v2/auth?state=s1&scope=openid');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(sources.calls.find((c) => c.path.endsWith('/credentials/oauth'))?.body).toEqual({
        provider: 'google',
        capabilities: ['files.read'],
      });

      sources.consentCompletes('google');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      await user.click(await screen.findByRole('button', { name: 'Look inside My Drive' }));
      await user.click(await screen.findByRole('button', { name: 'Connect Renewals' }));
      expect(await screen.findByRole('heading', { name: 'Renewals' })).toBeInTheDocument();
      expect(sources.calls.find((c) => c.method === 'POST' && c.path.endsWith('/source-connections'))?.body).toEqual({
        kind: 'google_drive',
        credentialId: sources.accounts[0]!['credentialId'],
        folder: 'fld1',
      });
      expect(screen.getByText('Up to date')).toBeInTheDocument();
      expect(screen.getByText(/Left out, never read: 1 shortcuts to places outside the folder/)).toBeInTheDocument();

      const found = screen.getByRole('region', { name: 'What XO thinks these are' });
      await user.click(within(found).getByRole('button', { name: "Yes, that's right" }));
      await waitFor(() => expect(within(found).getByText('Confirmed.')).toBeInTheDocument());

      await user.selectOptions(screen.getByRole('combobox', { name: 'How often XO syncs' }), 'Every hour');
      await waitFor(() =>
        expect(sources.calls.find((c) => c.path.endsWith('/schedule'))?.body).toEqual({ sync: { mode: 'interval', everyMinutes: 60 } }),
      );
      expect(await screen.findByText('Synced every 1 hour.')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retire asks first and says what it does; the list no longer shows it', async () => {
    const { api, sources } = setup();
    sources.consentCompletes('google');
    const user = await open(sources, api);
    await user.click(screen.getByRole('button', { name: 'Connect Google Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Look inside My Drive' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Renewals' }));
    await user.click(await screen.findByRole('button', { name: 'Retire' }));
    const ask = screen.getByRole('alertdialog', { name: 'Retire this connection?' });
    expect(within(ask).getByText(/Nothing is changed where the files live/)).toBeInTheDocument();
    expect(sources.calls.some((c) => c.path.endsWith('/retire'))).toBe(false);
    await user.click(within(ask).getByRole('button', { name: 'Retire it' }));
    expect(await screen.findByText('Retired')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Back to folders and drives' }));
    expect(await screen.findByText('Nothing is connected to this workspace yet.')).toBeInTheDocument();
  });

  it('a folder on the XO server, where allowed; a refusal is shown, not hidden', async () => {
    const { api, sources } = setup();
    sources.options = { ...sources.options, localFolder: { available: true } };
    const user = await open(sources, api);
    await user.click(screen.getByRole('button', { name: 'Connect a server folder' }));
    await user.type(screen.getByLabelText('Folder path on the XO server'), '/home/elsewhere');
    await user.click(screen.getByRole('button', { name: 'Connect folder' }));
    const refused = await screen.findByRole('alert');
    expect(within(refused).getByText('the folder is not inside a folder this instance allows')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Folder path on the XO server'));
    await user.type(screen.getByLabelText('Folder path on the XO server'), '/srv/xo/shared/Claims');
    await user.click(screen.getByRole('button', { name: 'Connect folder' }));
    expect(await screen.findByRole('heading', { name: 'Claims' })).toBeInTheDocument();
  });

  it('a server without source connections shows nothing of them', async () => {
    const { api, sources } = setup();
    sources.absent = true;
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={sources.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Old');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await workspaceReady('Old');
    await openScreen(user, 'Connect');
    await screen.findByRole('heading', { name: 'Connect' });
    await waitFor(() => expect(sources.calls.some((c) => c.path.endsWith('/options'))).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Folders and drives' })).toBeNull();
  });
});

describe('source connection wording', () => {
  it('says what a sync did, what it left out and what failed, in counts only', () => {
    expect(
      syncReportLines({
        at: '2026-11-17T09:00:00Z',
        outcome: 'partial',
        added: 2,
        changed: 1,
        unchanged: 4,
        removed: 1,
        failed: { refused_at_door: 1 },
        skipped: { sensitive_name: 2, native_not_exportable: 1 },
        truncated: 'max_files',
      }).slice(1),
    ).toEqual([
      'The folder is larger than XO lists at once, so nothing was retired for being absent.',
      'Left out, never read: 2 files whose names look like passwords or keys; 1 Google files XO cannot export (such as Slides).',
      '1 file could not be read or stored.',
    ]);
  });
  it('fills in the address when the instance has one, and says what to put otherwise', () => {
    expect(agentCommands(undefined, 'ABCD-EFGH-JKMN-PQRS').pair).toBe(
      'xo agent pair --server <this XO address> --code ABCD-EFGH-JKMN-PQRS --folder "<the folder>"',
    );
  });
});
