import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { FakeConnect } from '../fakeConnect';

async function open(connect: FakeConnect, api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={connect.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Claims Ops' });
  await user.click(screen.getByRole('button', { name: 'Connect' }));
  await screen.findByRole('heading', { name: 'Connect' });
  return user;
}
const setup = () => {
  const api = new FakeXo();
  return { api, connect: new FakeConnect(api) };
};

async function addFolder(user: ReturnType<typeof userEvent.setup>, pick = 'a.txt') {
  await user.click(await screen.findByRole('button', { name: 'Choose folder' }));
  await user.type(await screen.findByLabelText(/folder on this computer/i), '/data/claims');
  await user.click(screen.getByRole('button', { name: 'List folder' }));
  await user.click(await screen.findByRole('checkbox', { name: new RegExp(pick) }));
}

describe('Connect screen', () => {
  it('empty state, honest catalog: cloud sources are Coming soon and cannot be started', async () => {
    const { api, connect } = setup();
    await open(connect, api);
    expect(await screen.findByText(/connect your first source/i)).toBeInTheDocument();
    const cards = await screen.findAllByRole('heading', { level: 4 });
    expect(cards.map((c) => c.textContent)).toEqual(['Folder on this computer', 'Microsoft 365', 'Google Workspace']);
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Choose folder' })).toHaveLength(1);
    expect(screen.queryByText(/outlook|sharepoint/i)).not.toBeInTheDocument();
  });

  it('wizard: nothing is preselected, Confirm is disabled at zero, unreadable types cannot be chosen, then the source is created', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await user.click(await screen.findByRole('button', { name: 'Choose folder' }));
    await user.type(await screen.findByLabelText(/folder on this computer/i), '/data/claims');
    await user.click(screen.getByRole('button', { name: 'List folder' }));
    expect(await screen.findByText('Nothing chosen yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm selection' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /logo\.png/ })).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /a\.txt/ }));
    expect(screen.getByText(/1 item chosen/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm selection' }));
    expect(await screen.findByRole('heading', { name: 'claims' })).toBeInTheDocument();
    expect(screen.getByText('Ready to read')).toBeInTheDocument();
    expect(screen.getByText(/never edits, moves or deletes/i)).toBeInTheDocument();
    expect(connect.calls.find((c) => c.path === '/connect/local-folders')?.body).toEqual({ root: '/data/claims', includeKeys: ['a.txt'] });
  });

  it('a folder checkbox selects every readable item under it (tri-state)', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await user.click(await screen.findByRole('button', { name: 'Choose folder' }));
    await user.type(await screen.findByLabelText(/folder on this computer/i), '/data/claims');
    await user.click(screen.getByRole('button', { name: 'List folder' }));
    const policies = await screen.findByRole('checkbox', { name: /policies/ });
    await user.click(screen.getByRole('checkbox', { name: /limits\.md/ }));
    expect((policies as HTMLInputElement).indeterminate).toBe(false); // only readable files count: the one readable file is chosen
    expect(policies).toBeChecked();
  });

  it('read: the result is honest that it was kept but not understood, and never says XO learned', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await addFolder(user);
    await user.click(await screen.findByRole('button', { name: 'Confirm selection' }));
    await user.click(await screen.findByRole('button', { name: 'Read now' }));
    const [text] = await screen.findAllByText(/XO kept what it read/); // shown as the last read and in the history
    expect(text!.textContent).toMatch(/kept but not understood yet: only structured organizational records become knowledge today/);
    expect(text!.textContent).not.toMatch(/learned/i);
    expect(await screen.findByText('Read')).toBeInTheDocument();
  });

  it('disconnect says what is kept and offers only reconnect and remove afterwards', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await addFolder(user);
    await user.click(await screen.findByRole('button', { name: 'Confirm selection' }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/What XO already learned is kept, and nothing in your folder was changed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read now' })).not.toBeInTheDocument();
  });

  it('remove: shows what it affects, makes no claim about other sources, then forgets the source', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await addFolder(user);
    await user.click(await screen.findByRole('button', { name: 'Confirm selection' }));
    await user.click(await screen.findByRole('button', { name: 'Remove source…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(/4 pieces of evidence/)).toBeInTheDocument();
    expect(within(dialog).getByText(/makes no claim about facts that other sources may also support/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Your files are not touched/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Remove source' }));
    expect(await screen.findByText(/connect your first source/i)).toBeInTheDocument();
    expect(connect.calls.some((c) => c.path.endsWith('/remove'))).toBe(true);
  });

  it('changing the selection re-lists the folder with the current choice and reports narrowing', async () => {
    const { api, connect } = setup();
    const user = await open(connect, api);
    await addFolder(user);
    await user.click(screen.getByRole('checkbox', { name: /limits\.md/ }));
    await user.click(await screen.findByRole('button', { name: 'Confirm selection' }));
    await user.click(await screen.findByRole('button', { name: 'Change what XO reads' }));
    const a = await screen.findByRole('checkbox', { name: /a\.txt/ });
    expect(a).toBeChecked();
    await user.click(a);
    await user.click(screen.getByRole('button', { name: 'Save selection' }));
    await screen.findByRole('heading', { name: 'claims' });
    expect(connect.calls.find((c) => c.path.endsWith('/selection'))?.body).toEqual({ includeKeys: ['policies/limits.md'] });
  });

  it('expired access: its own state, keeps earlier knowledge, offers no Read', async () => {
    const { api, connect } = setup();
    connect.sources.push({
      id: 'src_x',
      displayName: 'Shared drive',
      state: 'access_expired',
      selectedKeys: ['a'],
      history: [],
      attention: {
        code: 'access_expired',
        message:
          'XO can no longer read this source. Earlier knowledge is kept and may be out of date until you reconnect or remove the source.',
      },
    });
    const user = await open(connect, api);
    expect(await screen.findByText('Access expired')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Earlier knowledge is kept and may be out of date/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read now' })).not.toBeInTheDocument();
  });

  it('without manage capability nothing that changes anything is offered', async () => {
    const { api, connect } = setup();
    connect.manage = false;
    connect.sources.push({ id: 'src_x', displayName: 'claims', state: 'read_complete', selectedKeys: ['a'], history: [] });
    const user = await open(connect, api);
    expect(await screen.findByText(/cannot add or change them/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled();
    await user.click(await screen.findByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'claims' });
    for (const name of ['Read now', 'Disconnect', 'Remove source…', 'Change what XO reads'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('if the capability query fails, changing actions stay hidden and the user is told', async () => {
    const { api, connect } = setup();
    connect.capsStatus = 503;
    await open(connect, api);
    expect(await screen.findByText(/could not confirm what you may do here/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeDisabled();
  });

  it('a server answer that breaks the contract is shown as a problem, never as data', async () => {
    const { api, connect } = setup();
    connect.malformedCatalog = true;
    await open(connect, api);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Microsoft 365')).not.toBeInTheDocument();
  });
});
