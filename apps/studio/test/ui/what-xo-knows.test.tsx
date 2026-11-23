/**
 * UW-12b (ADR 0052) — What XO knows: the approved records, disagreements, packs, a search, the changes waiting for review (with
 * what each would change and which certified workflows it touches), and the history with going back.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, workspaceReady } from './nav';

async function open(api: FakeXo) {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  await openScreen(user, 'What XO knows');
  await screen.findByRole('heading', { name: 'What XO knows' });
  return user;
}
const seeded = () => {
  const api = new FakeXo();
  api.knowledge.entries = [
    { id: 'kr_1', kind: 'entity', lifecycle: 'active', label: 'Acme Ltd' },
    { id: 'kr_2', kind: 'entity', lifecycle: 'active', label: 'Beta Corp' },
    { id: 'kr_3', kind: 'claim', lifecycle: 'active', label: 'core.pays-within' },
  ];
  api.knowledge.conflicts = [{ id: 'kcf_1', reason: 'two different payment terms for Acme Ltd', status: 'unresolved' }];
  api.knowledge.packs = [{ packId: 'pack.finance', namespace: 'fin', version: '1.2.0' }];
  return api;
};

describe('What XO knows', () => {
  it('lists what is known, what disagrees and which packs are installed, and searches', async () => {
    const api = seeded();
    const user = await open(api);
    expect(await screen.findByLabelText('Summary')).toHaveTextContent(
      '2 things, 1 fact and 0 links are known. 1 disagreement needs a decision.',
    );
    const known = await screen.findByRole('list', { name: 'Known records' });
    expect(within(known).getByText(/Acme Ltd/)).toBeInTheDocument();
    expect(within(known).getByText(/core\.pays-within/)).toBeInTheDocument();
    expect(within(await screen.findByRole('list', { name: 'Disagreements' })).getByText(/two different payment terms/)).toBeInTheDocument();
    expect(within(await screen.findByRole('list', { name: 'Installed packs' })).getByText(/pack\.finance 1\.2\.0/)).toBeInTheDocument();

    await user.type(screen.getByLabelText('Search what XO knows'), 'acme');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const hits = await screen.findByRole('list', { name: 'Search results' });
    expect(within(hits).getByText(/Acme Ltd/)).toBeInTheDocument();
    expect(within(hits).queryByText(/Beta Corp/)).toBeNull();
    expect(api.knowledge.searched).toEqual(['acme']);
    await user.clear(screen.getByLabelText('Search what XO knows'));
    await user.type(screen.getByLabelText('Search what XO knows'), 'zzz');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/Nothing matches/)).toBeInTheDocument();
  });

  it('a change waiting for review shows what it would change and which workflows it touches; approving needs a reason', async () => {
    const api = seeded();
    api.knowledge.changeSets = [{ id: 'kcs_a', status: 'proposed', origin: 'run-outcome', by: 'ana', affected: 2 }];
    const user = await open(api);
    const card = await screen.findByLabelText('A change waiting for review');
    expect(within(card).getByText('Proposed from what happened in a run')).toBeInTheDocument();
    expect(await within(card).findByText('2 added')).toBeInTheDocument();
    expect(within(card).getByLabelText('Workflows it touches')).toHaveTextContent('It touches 2 certified workflows');
    const approve = within(card).getByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    await user.type(within(card).getByLabelText('Reason'), 'checked against the contract');
    await user.click(approve);
    await waitFor(() =>
      expect(api.knowledge.decisions).toEqual([{ id: 'kcs_a', action: 'approve', reason: 'checked against the contract' }]),
    );
    expect(await screen.findByText('Approved. XO now knows this.')).toBeInTheDocument();
  });

  it('a change made stale by a newer state cannot be approved as it is', async () => {
    const api = seeded();
    api.knowledge.changeSets = [{ id: 'kcs_a', status: 'proposed', origin: 'manual', by: 'ana', stale: true }];
    const user = await open(api);
    const card = await screen.findByLabelText('A change waiting for review');
    await user.type(within(card).getByLabelText('Reason'), 'ok');
    expect(await within(card).findByText(/has changed since this was proposed/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(api.knowledge.decisions).toEqual([]);
  });

  it('going back names the state it goes back to, needs a reason, and only proposes', async () => {
    const api = seeded();
    api.knowledge.states.push({ stateId: 'kst_earlier000000000', parentStateId: null, changeSetId: 'kcs_old' });
    const user = await open(api);
    const history = await screen.findByRole('list', { name: 'Earlier states of what XO knows' });
    const rows = within(history).getAllByRole('listitem');
    expect(within(rows[0]!).queryByRole('button', { name: 'Go back to this' })).toBeNull(); // the current state
    await user.click(within(rows[1]!).getByRole('button', { name: 'Go back to this' }));
    const form = await screen.findByRole('group', { name: 'Go back' });
    expect(form).toHaveTextContent('state kst_earlier0');
    expect(within(form).getByRole('button', { name: 'Propose going back' })).toBeDisabled();
    await user.type(within(form).getByLabelText('Why?'), 'that import was wrong');
    await user.click(within(form).getByRole('button', { name: 'Propose going back' }));
    await waitFor(() => expect(api.knowledge.rollbacks).toEqual([{ toStateId: 'kst_earlier000000000', reason: 'that import was wrong' }]));
    expect(await screen.findByText('Proposed. Someone else has to approve it before XO goes back.')).toBeInTheDocument();
    expect(api.knowledge.decisions).toEqual([]);
  });
});
