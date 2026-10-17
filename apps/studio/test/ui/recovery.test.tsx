import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;
const posts = (api: FakeXo, suffix: string) => api.calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));
const go = (user: U, name: RegExp | string) => openScreen(user, name);

async function connect(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  return user;
}

/** A person starts a process, the service stops mid-step, and they come back later in a fresh session. */
async function returnToInterruptedRun(api: FakeXo): Promise<U> {
  api.approvals.all = true;
  let user = await connect(api);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await go(user, /^setup/i);
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await go(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /start this process/i }));
  await screen.findByRole('button', { name: /approve this step/i });
  api.interruptRun(api.workflowRuns[0]!);
  cleanup(); // the browser is closed; the person returns later
  window.history.replaceState(null, '', window.location.pathname); // ...to a fresh URL, with no remembered section
  user = await connect(api);
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

describe('an interrupted process is discoverable', () => {
  it('shows on Home, in the Tasks count, in Work and in Activity, with the real state', async () => {
    const api = new FakeXo();
    const user = await returnToInterruptedRun(api);
    expect(await screen.findByText('Stopped — can be continued')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^runs & history.*1 need attention/i })).toBeInTheDocument();
    await go(user, 'Work');
    expect(await screen.findByRole('button', { name: /continue in tasks/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start this process/i })).not.toBeInTheDocument(); // never a second run
    await go(user, 'Activity');
    expect((await screen.findAllByText('Interrupted')).length).toBeGreaterThan(0);
  });

  it('says what continuing will do, and does not offer a decision on an interrupted step', async () => {
    const api = new FakeXo();
    const user = await returnToInterruptedRun(api);
    await go(user, /^tasks/i);
    expect(await screen.findByText(/runs the interrupted step again as a new attempt/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot tell whether that step had any effect outside xo/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve this step/i })).not.toBeInTheDocument();
  });
});

describe('continuing an interrupted process', () => {
  async function open(api: FakeXo): Promise<U> {
    const user = await returnToInterruptedRun(api);
    await go(user, /^tasks/i);
    await screen.findByRole('button', { name: /continue this process/i });
    return user;
  }

  it('reads first, sends only the fresh revision, keeps the same run, and creates no new one', async () => {
    const api = new FakeXo();
    const user = await open(api);
    const rev = api.workflowRuns[0]!.revision;
    const startsBefore = posts(api, '/workflows/wf_1/executions').length;
    await user.click(screen.getByRole('button', { name: /continue this process/i }));
    expect(await screen.findByRole('button', { name: /approve this step/i })).toBeInTheDocument();
    const resume = posts(api, '/resume');
    expect(resume).toHaveLength(1);
    expect(resume[0]!.body).toEqual({ expectedRevision: rev }); // no decision, no data, no step id
    expect(posts(api, '/workflows/wf_1/executions')).toHaveLength(startsBefore);
    expect(api.workflowRuns).toHaveLength(1);
    expect(api.workflowRuns[0]!.workflowExecutionId).toBe('wfx_00000001');
    const iGet = api.calls.findIndex((c) => c.method === 'GET' && /workflow-executions\/wfx_/.test(c.path));
    const iPost = api.calls.findIndex((c) => c.path.endsWith('/resume'));
    expect(iGet).toBeGreaterThan(-1);
    expect(iGet).toBeLessThan(iPost); // read before write
  });

  it('a double click sends one recovery', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await user.dblClick(screen.getByRole('button', { name: /continue this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
    expect(posts(api, '/resume')).toHaveLength(1);
  });

  it('treats a stale revision (409) as a change: explains, refreshes, does not resend', async () => {
    const api = new FakeXo();
    const user = await open(api);
    api.bumpRevisionBeforeResume = true;
    await user.click(screen.getByRole('button', { name: /continue this process/i }));
    expect(await screen.findByText('This process has changed')).toBeInTheDocument();
    expect(screen.getByText(/was not continued again/i)).toBeInTheDocument();
    expect(posts(api, '/resume')).toHaveLength(1);
    expect(api.workflowRuns[0]!.status).toBe('interrupted');
    // choosing again works against the refreshed revision
    api.bumpRevisionBeforeResume = false;
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /continue this process/i })).not.toHaveAttribute('aria-disabled', 'true'),
    );
    await user.click(screen.getByRole('button', { name: /continue this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
  });

  it('does nothing if someone else already continued it', async () => {
    const api = new FakeXo();
    const user = await open(api);
    api.recoverRun(api.workflowRuns[0]!); // another person continued it meanwhile
    await user.click(screen.getByRole('button', { name: /continue this process/i }));
    expect(await screen.findByText(/no longer interrupted, so nothing was continued/i)).toBeInTheDocument();
    expect(posts(api, '/resume')).toHaveLength(0);
  });

  it('after an unclear failure that DID apply, reports from platform state and does not resend', async () => {
    const api = new FakeXo();
    const user = await open(api);
    api.resumeBehavior = 'network_after_apply';
    await user.click(screen.getByRole('button', { name: /continue this process/i }));
    expect(
      await screen.findByText(/did not confirm the request to continue, but its records show the process has since moved on/i),
    ).toBeInTheDocument();
    expect(posts(api, '/resume')).toHaveLength(1);
  });

  it('after an unclear failure that applied nothing, says nothing was resent and it is still interrupted', async () => {
    const api = new FakeXo();
    const user = await open(api);
    api.resumeBehavior = 'network_before';
    await user.click(screen.getByRole('button', { name: /continue this process/i }));
    expect(await screen.findByText(/nothing was resent/i)).toBeInTheDocument();
    expect(api.workflowRuns[0]!.status).toBe('interrupted');
  });

  it('shows the continued run as waiting for a decision and keeps the earlier attempt on record', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await user.click(screen.getByRole('button', { name: /continue this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
    expect(api.workflowRuns[0]!.steps[0]!.supersededExecutionIds).toHaveLength(1);
    expect(within(screen.getByRole('list', { name: /steps/i })).getAllByText('Waiting for a decision').length).toBeGreaterThan(0);
  });
});
