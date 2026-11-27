import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { runPath, runRouteOf, sectionOf } from '../../src/ui/sectionRoute';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, workspaceReady } from './nav';

type U = ReturnType<typeof userEvent.setup>;

async function connect(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
}

async function withRun(): Promise<{ user: U; api: FakeXo }> {
  const api = new FakeXo();
  api.approvals.all = true;
  let user = await connect(api);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  await openScreen(user, /^setup/i);
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await api.seedHistoricRun();
  api.generatedRuns.push({ runId: 'run_9', state: 'completed', pendingApprovals: [], decisions: [] });
  cleanup();
  window.history.replaceState(null, '', '/');
  user = await connect(api);
  await workspaceReady('Ops');
  return { user, api };
}

describe('run addresses', () => {
  it('a run path round-trips and nothing else is read as one', () => {
    expect(runRouteOf(runPath('w1', 'r-9'))).toEqual({ runId: 'r-9' });
    expect(runRouteOf('/w/w1/activity/runs/a/b')).toBeUndefined();
    expect(runRouteOf('/w/w1/activity')).toBeUndefined();
  });
});

describe('Activity: filters and the run page', () => {
  it('narrows by workflow and by when, saying it covers the runs loaded', async () => {
    const { user } = await withRun();
    await openScreen(user, 'Activity');
    const when = await screen.findByLabelText('When');
    expect(screen.queryByText(/among the/)).not.toBeInTheDocument();
    await user.selectOptions(when, 'day');
    expect(await screen.findByText(/among the \d+ loaded/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Workflow'), '');
    await user.selectOptions(when, 'any');
    expect(screen.queryByText(/among the/)).not.toBeInTheDocument();
  });

  it('opens a run on its own address, with its results shown, and goes back', async () => {
    const { user } = await withRun();
    await openScreen(user, 'Activity');
    const list = await screen.findByRole('list', { name: 'Runs' });
    const link = list.querySelector('h3 button') as HTMLButtonElement | null;
    expect(link).not.toBeNull();
    await user.click(link!);
    await waitFor(() => expect(sectionOf(window.location)).toBe('run'));
    expect(await screen.findByRole('button', { name: 'Hide results' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to Activity' }));
    await waitFor(() => expect(sectionOf(window.location)).toBe('activity'));
  });

  it('a run address that names nothing says so instead of guessing', async () => {
    const { api } = await withRun();
    cleanup();
    window.history.replaceState(null, '', runPath(api.workspaces[0]!.workspaceId, 'no-such-run'));
    await connect(api);
    expect(await screen.findByText('This run is not among the recent ones')).toBeInTheDocument();
    expect(sectionOf(window.location)).toBe('run');
  });
});
