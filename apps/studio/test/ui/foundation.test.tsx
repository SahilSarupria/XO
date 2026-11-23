import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, setDetailLevel, findStart, openWorkflow, workspaceReady } from './nav';

type U = ReturnType<typeof userEvent.setup>;
const go = (user: U, name: RegExp | string) => openScreen(user, name);
const gets = (api: FakeXo, suffix: string) => api.calls.filter((c) => c.method === 'GET' && c.path.endsWith(suffix)).length;

async function connect(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
}

/** Creates a workspace and an analysed document, then closes the browser. */
async function seed(api: FakeXo): Promise<void> {
  api.approvals.all = true;
  const user = await connect(api);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  await go(user, /^setup/i);
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  cleanup();
}
async function returnLater(api: FakeXo): Promise<U> {
  const user = await connect(api);
  await workspaceReady('Ops');
  return user;
}
async function startRun(user: U) {
  await go(user, 'Work');
  await user.click(await findStart(user));
  await screen.findByRole('button', { name: /approve this step/i });
}

describe('a failed load is never presented as an empty result', () => {
  it('Tasks reports that decisions could not be loaded instead of "Nothing is waiting for you", and recovers on retry', async () => {
    const api = new FakeXo();
    await seed(api);
    api.failing.add('/executions');
    const user = await returnLater(api);
    await user.click(screen.getByRole('button', { name: /^inbox/i }));
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting for you')).not.toBeInTheDocument();
    api.failing.clear();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
  });

  it('Work says approvals could not be checked (not "Checking…" forever) and recovers on retry', async () => {
    const api = new FakeXo();
    await seed(api);
    api.failing.add('/capabilities');
    const user = await returnLater(api);
    await go(user, 'Work');
    await screen.findByText(/could not check approvals/i);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByText(/could not check approvals/i)).toBeInTheDocument();
    await openWorkflow(user);
    expect(screen.getByRole('button', { name: /start this workflow/i })).toBeDisabled();
    api.failing.clear();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /start this workflow/i })).toBeEnabled());
  });
});

describe('no duplicate requests', () => {
  it("Builder Mode's Processes tab reuses the workflows already loaded", async () => {
    const api = new FakeXo();
    await seed(api);
    const user = await returnLater(api);
    await waitFor(() => expect(gets(api, '/workflows')).toBeGreaterThan(0));
    const before = gets(api, '/workflows');
    await setDetailLevel(user, 'builder');
    await openScreen(user, 'Processes');
    expect(await screen.findByText('Can run')).toBeInTheDocument();
    expect(gets(api, '/workflows')).toBe(before);
  });
});
