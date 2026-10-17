import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;
const go = (user: U, name: RegExp | string) => openScreen(user, name);
const gets = (api: FakeXo, suffix: string) => api.calls.filter((c) => c.method === 'GET' && c.path.endsWith(suffix)).length;

async function connect(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  return user;
}

/** Creates a workspace and an analysed document, then closes the browser. */
async function seed(api: FakeXo): Promise<void> {
  api.approvals.all = true;
  const user = await connect(api);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await go(user, /^setup/i);
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  cleanup();
}
async function returnLater(api: FakeXo): Promise<U> {
  const user = await connect(api);
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}
async function startRun(user: U) {
  await go(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /start this process/i }));
  await screen.findByRole('button', { name: /approve this step/i });
}

describe('a failed load is never presented as an empty result', () => {
  it('Tasks reports that decisions could not be loaded instead of "Nothing is waiting for you", and recovers on retry', async () => {
    const api = new FakeXo();
    await seed(api);
    api.failing.add('/executions');
    const user = await returnLater(api);
    await user.click(screen.getByRole('button', { name: /^runs & history/i }));
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
    expect(screen.getByRole('button', { name: /start this process/i })).toBeDisabled();
    api.failing.clear();
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /start this process/i })).toBeEnabled());
  });
});

describe('a failed refresh keeps what was already loaded', () => {
  it('a decision still on screen does not vanish because the next runs refresh failed', async () => {
    const api = new FakeXo();
    await seed(api);
    const user = await returnLater(api);
    await startRun(user);
    await go(user, /^tasks/i);
    expect(await screen.findByRole('button', { name: /approve this step/i })).toBeInTheDocument();
    // someone else's change happens; our next refresh of the runs list fails
    api.failing.add('/workflow-executions');
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText(/showing what was loaded earlier/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting for you')).not.toBeInTheDocument();
  });
});

describe('no duplicate requests', () => {
  it("Builder Mode's Processes tab reuses the workflows already loaded", async () => {
    const api = new FakeXo();
    await seed(api);
    const user = await returnLater(api);
    await waitFor(() => expect(gets(api, '/workflows')).toBeGreaterThan(0));
    const before = gets(api, '/workflows');
    await go(user, 'Builder');
    await user.click(await screen.findByRole('button', { name: 'Processes' }));
    expect(await screen.findByText('Can run')).toBeInTheDocument();
    expect(gets(api, '/workflows')).toBe(before);
  });
});

describe('keyboard and assistive technology', () => {
  it('keeps focus on the decision button while a decision is pending and after it lands', async () => {
    const api = new FakeXo();
    await seed(api);
    const user = await returnLater(api);
    await startRun(user);
    await go(user, /^tasks/i);
    const approve = await screen.findByRole('button', { name: /approve this step/i });
    approve.focus();
    await user.keyboard('{Enter}'); // keyboard activation
    await screen.findAllByText(/step 2 of 2/i);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /approve this step/i }));
  });

  it('while pending, a decision button is announced as unavailable without leaving the tab order', async () => {
    const api = new FakeXo();
    await seed(api);
    const user = await returnLater(api);
    await startRun(user);
    await go(user, /^tasks/i);
    const approve = await screen.findByRole('button', { name: /approve this step/i });
    await user.click(approve);
    await screen.findAllByText(/step 2 of 2/i);
    const again = screen.getByRole('button', { name: /approve this step/i });
    expect(again).toHaveAttribute('aria-disabled', 'true'); // settling
    expect(again).not.toBeDisabled(); // so focus is never dropped
    await waitFor(() => expect(again).not.toHaveAttribute('aria-disabled', 'true'));
  });

  it('announces a confirmed decision, only after the platform confirmed it', async () => {
    const api = new FakeXo();
    await seed(api);
    const user = await returnLater(api);
    await startRun(user);
    await go(user, /^tasks/i);
    api.resumeBehavior = 'network_before';
    await user.click(await screen.findByRole('button', { name: /approve this step/i }));
    await screen.findByText(/nothing was resent/i);
    expect(screen.queryByText(/decision recorded/i)).not.toBeInTheDocument(); // no success claim without confirmation
    api.resumeBehavior = 'ok';
    await waitFor(() => expect(screen.getByRole('button', { name: /approve this step/i })).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText(/decision recorded/i)).toBeInTheDocument();
  });
});
