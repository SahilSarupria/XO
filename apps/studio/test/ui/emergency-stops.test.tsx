/**
 * UW-12b (ADR 0052) — emergency stops, under Settings → Operations: the instance-wide stop is shown read-only, engaging and
 * releasing each ask first and say what they do.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { chooseFromMenu } from './nav';

async function openOperations(api: FakeXo) {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await chooseFromMenu(user, 'Settings');
  await user.click(await screen.findByRole('tab', { name: 'Operations' }));
  return { user, view: within(await screen.findByRole('region', { name: 'Emergency stops' })) };
}

describe('emergency stops', () => {
  it('shows the instance stop read-only and the workspace stops with what they hold', async () => {
    const api = new FakeXo();
    api.instanceStop = { at: '2026-11-20T10:00:00.000Z', reason: 'maintenance' };
    api.stops = [{ scope: 'connector', target: 'mail', by: 'sally', at: '2026-11-20T10:00:00.000Z', reason: 'wrong sender' }];
    const { view } = await openOperations(api);
    expect(
      await view.findByText(/Everything on this XO is stopped by whoever runs it: maintenance\. You cannot change this here\./),
    ).toBeInTheDocument();
    const list = view.getByRole('list', { name: 'Stops in place' });
    expect(within(list).getByText('Nothing in this workspace can use mail.')).toBeInTheDocument();
    expect(within(list).getByText(/Stopped by sally .*: wrong sender\./)).toBeInTheDocument();
    // No control offers to release the instance stop.
    expect(view.getAllByRole('button', { name: 'Release' })).toHaveLength(1);
  });

  it('engaging asks first, says what it does, and sends the stop only after the confirmation', async () => {
    const api = new FakeXo();
    const { user, view } = await openOperations(api);
    const group = within(await view.findByRole('group', { name: 'Stop something' }));
    expect(group.getByRole('button', { name: 'Stop it' })).toBeDisabled(); // a target first
    await user.selectOptions(group.getByLabelText('What to stop'), 'capability');
    await user.type(group.getByLabelText(/The operation, for example/), 'mail.send_certificate');
    await user.type(group.getByLabelText('Why (optional)'), 'wrong template');
    await user.click(group.getByRole('button', { name: 'Stop it' }));
    expect(api.stopCalls).toEqual([]); // not yet: it asks
    const confirm = within(await view.findByRole('group', { name: 'Confirm' }));
    expect(confirm.getByText(/This stops mail\.send_certificate now/)).toBeInTheDocument();
    await user.click(confirm.getByRole('button', { name: 'Yes, stop it' }));
    await waitFor(() =>
      expect(api.stopCalls).toEqual([{ action: 'engage', scope: 'capability', target: 'mail.send_certificate', reason: 'wrong template' }]),
    );
    expect(await view.findByText('Stopped: mail.send_certificate.')).toBeInTheDocument();
    expect(
      within(view.getByRole('list', { name: 'Stops in place' })).getByText(/mail\.send_certificate cannot be used by any run\./),
    ).toBeInTheDocument();
  });

  it('releasing asks first and says that refused runs are not restarted', async () => {
    const api = new FakeXo();
    api.stops = [{ scope: 'workflow', target: 'wfl_1', by: 'sally', at: '2026-11-20T10:00:00.000Z' }];
    const { user, view } = await openOperations(api);
    await user.click(await view.findByRole('button', { name: 'Release' }));
    expect(api.stopCalls).toEqual([]);
    const confirm = within(await view.findByRole('group', { name: 'Confirm' }));
    expect(confirm.getByText(/Runs that were refused are not restarted/)).toBeInTheDocument();
    await user.click(confirm.getByRole('button', { name: 'Yes, release it' }));
    await waitFor(() => expect(api.stopCalls).toEqual([{ action: 'release', scope: 'workflow', target: 'wfl_1' }]));
    expect(await view.findByText('Released: wfl_1.')).toBeInTheDocument();
    expect(await view.findByText('Nothing is stopped.')).toBeInTheDocument();
  });

  it('a person who cannot manage the workspace sees the stops but cannot change them', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.stops = [{ scope: 'workflow', target: 'wfl_1', by: 'sally', at: '2026-11-20T10:00:00.000Z' }];
    const { view } = await openOperations(api);
    expect(await view.findByRole('button', { name: 'Release' })).toBeDisabled();
    expect(view.getByRole('button', { name: 'Stop it' })).toBeDisabled();
  });
});
