import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

type U = ReturnType<typeof userEvent.setup>;

async function open(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

/** Uploads + analyses a document in Setup. Leaves the user in Setup > Rules. */
async function analysed(api: FakeXo): Promise<U> {
  const user = await open(api);
  await user.click(screen.getByRole('button', { name: /^setup/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  return user;
}

const goTo = (user: U, name: RegExp | string) => user.click(screen.getByRole('button', { name }));
const posts = (api: FakeXo, suffix: string) => api.calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));

describe('shell stays business-neutral', () => {
  it('uses task-oriented navigation with no industry vocabulary', async () => {
    const api = new FakeXo();
    await open(api);
    const nav = screen.getByRole('navigation', { name: /workspace sections/i });
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.querySelector('.nav-label')?.textContent),
    ).toEqual(['Home', 'Work', 'Tasks', 'Activity', 'Setup']);
    expect(nav.textContent).not.toMatch(/insur|polic|commission|tds|capabilit|xoir|compil/i);
  });
});

describe('Home', () => {
  it('with nothing set up, says what to do next and shows no cards or metrics', async () => {
    const api = new FakeXo();
    await open(api);
    expect(await screen.findByText('Add your first document')).toBeInTheDocument();
    expect(screen.queryByText(/waiting for you/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ready to start/i)).not.toBeInTheDocument();
  });

  it('surfaces a real waiting decision and links to Tasks', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    await screen.findByRole('heading', { name: 'Tasks' });
    await goTo(user, 'Home');
    expect(await screen.findByText('Waiting for you')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /review this decision/i }));
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
  });
});

describe('Work: starting', () => {
  it('lists the steps, says approvals are missing, and does not offer a usable Start', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await goTo(user, 'Work');
    expect((await screen.findAllByText('Record before payment')).length).toBeGreaterThan(0);
    expect(screen.getByText(/2 of 2 steps still need your approval/i)).toBeInTheDocument();
    expect(screen.getByText('Needs approval')).toBeInTheDocument(); // the badge never says "Ready to start" while approvals are missing
    expect(screen.queryByText('Ready to start')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start this process/i })).toBeDisabled();
  });

  it('explains a process the platform cannot run, and starts nothing', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.workflowExecutable = false;
    const user = await analysed(api);
    await goTo(user, 'Work');
    expect(await screen.findByText('Cannot run yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start this process/i })).toBeDisabled();
  });

  it('starts exactly one run and lands on the waiting decision', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    expect(await screen.findByRole('button', { name: /approve this step/i })).toBeInTheDocument();
    expect(posts(api, '/workflows/wf_1/executions')).toHaveLength(1);
    expect(api.workflowRuns).toHaveLength(1);
  });

  it('a double click from one interaction sends one start', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.dblClick(await screen.findByRole('button', { name: /start this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
    expect(posts(api, '/workflows/wf_1/executions')).toHaveLength(1);
  });

  it('directs to an existing active run instead of starting another', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
    await goTo(user, 'Work');
    expect(await screen.findByRole('button', { name: /continue in tasks/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /start this process/i })).not.toBeInTheDocument();
  });

  it('re-checks right before starting: a run created elsewhere is not duplicated', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    const start = await screen.findByRole('button', { name: /start this process/i });
    // another client starts it after this screen loaded
    const cid = api.compilations[0]!.compilationId;
    await api.fetch('/api/workspaces/w/workflows/wf_1/executions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.validKey}` },
      body: JSON.stringify({ compilationId: cid }),
    });
    expect(api.workflowRuns).toHaveLength(1);
    await user.click(start);
    expect(await screen.findByText(/already in progress, so a second one was not started/i)).toBeInTheDocument();
    expect(api.workflowRuns).toHaveLength(1);
  });

  it('turns the platform approval denial into the steps that need approval', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    const start = await screen.findByRole('button', { name: /start this process/i });
    api.approvals.all = false; // the server no longer agrees with what the screen showed
    await user.click(start);
    expect(await screen.findByText('Some steps need approval first')).toBeInTheDocument();
    expect(screen.getAllByText('Record before payment').length).toBeGreaterThan(1);
    expect(api.workflowRuns).toHaveLength(0);
  });

  it('after an unclear failure that DID create the run, checks and reports it, with a single start request', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.startBehavior = 'network_after_create';
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    expect(await screen.findByText(/the process did start/i)).toBeInTheDocument();
    expect(posts(api, '/workflows/wf_1/executions')).toHaveLength(1);
    expect(api.workflowRuns).toHaveLength(1);
  });

  it('after an unclear failure that created nothing, says so honestly and never retries on its own', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.startBehavior = 'network_before';
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    expect(await screen.findByText(/did not confirm whether this started/i)).toBeInTheDocument();
    expect(screen.getByText(/carries the same request key/i)).toBeInTheDocument();
    expect(posts(api, '/workflows/wf_1/executions')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /start this process/i })).toBeEnabled(); // offered again only after checking
  });
});

async function withWaitingRun(api: FakeXo): Promise<U> {
  api.approvals.all = true;
  const user = await analysed(api);
  await goTo(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /start this process/i }));
  await screen.findByRole('button', { name: /approve this step/i });
  return user;
}

describe('Tasks: deciding', () => {
  it('shows the current step and sends the fresh step id and revision', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    expect(screen.getAllByText(/step 1 of 2: record before payment/i).length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    await screen.findAllByText(/step 2 of 2: review not covered/i);
    const resume = posts(api, '/resume')[0]!.body as Record<string, unknown>;
    expect(resume).toEqual({ decision: 'approve', expectedStepExecutionId: 'exe_s0_1', expectedRevision: 3 });
    // read before write
    const iGet = api.calls.findIndex((c) => c.method === 'GET' && /workflow-executions\/wfx_/.test(c.path));
    const iPost = api.calls.findIndex((c) => c.path.endsWith('/resume'));
    expect(iGet).toBeGreaterThan(-1);
    expect(iGet).toBeLessThan(iPost);
  });

  it('finishing the last step shows Completed, and rejecting stops it and is not shown as completed', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    await screen.findAllByText(/step 2 of 2/i);
    await waitFor(() => expect(screen.getByRole('button', { name: /reject and stop/i })).not.toHaveAttribute('aria-disabled', 'true'));
    await user.click(screen.getByRole('button', { name: /reject and stop/i }));
    expect(await screen.findAllByText('Stopped by a person')).not.toHaveLength(0);
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
    expect(api.workflowRuns[0]!.status).toBe('rejected');
  });

  it('does not decide on a step that moved on since it was shown', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    api.applyDecision(api.workflowRuns[0]!, 'approve'); // another person approved step 1
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText(/moved to a different step since you opened it/i)).toBeInTheDocument();
    expect(posts(api, '/resume')).toHaveLength(0);
    expect(screen.getAllByText(/step 2 of 2: review not covered/i).length).toBeGreaterThan(0);
  });

  it('treats a 409 as recoverable: explains, refreshes, and does not resend', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    api.bumpRevisionBeforeResume = true;
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText('This process has changed')).toBeInTheDocument();
    expect(screen.getByText(/your decision was not applied/i)).toBeInTheDocument();
    expect(posts(api, '/resume')).toHaveLength(1);
    expect(api.workflowRuns[0]!.steps[0]!.status).toBe('waiting_for_human'); // nothing was applied
    // the person can choose again against the refreshed state
    api.bumpRevisionBeforeResume = false;
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    await screen.findAllByText(/step 2 of 2/i);
  });

  it('after an unclear failure that DID apply, reports from the platform state and does not resend', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    api.resumeBehavior = 'network_after_apply';
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(
      await screen.findByText(/did not confirm your decision, but its records show this process has since moved on/i),
    ).toBeInTheDocument();
    expect(posts(api, '/resume')).toHaveLength(1);
  });

  it('after an unclear failure that applied nothing, says nothing was resent', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    api.resumeBehavior = 'network_before';
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText(/nothing was resent/i)).toBeInTheDocument();
    expect(api.workflowRuns[0]!.steps[0]!.status).toBe('waiting_for_human');
  });

  it('keeps one decision in flight per card (rapid double click sends one resume)', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.dblClick(screen.getByRole('button', { name: /approve this step/i }));
    await screen.findAllByText(/step 2 of 2/i);
    // the second click of the same double click must not decide the NEXT step
    expect(posts(api, '/resume')).toHaveLength(1);
    expect(api.workflowRuns[0]!.steps[1]!.status).toBe('waiting_for_human');
  });
});

describe('Tasks and Activity', () => {
  it('shows an empty state when nothing is waiting', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await goTo(user, /^tasks/i);
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
  });

  it('shows a run in Activity with its real state, once, and not as a separate single-rule run', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await goTo(user, 'Activity');
    expect(await screen.findByRole('heading', { name: 'Processes' })).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for a decision').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: /individual rules run/i })).not.toBeInTheDocument();
  });

  it('Builder Mode adds technical detail without adding authority or requests', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    expect(screen.queryByText(/wfx_/)).not.toBeInTheDocument();
    const before = api.calls.length;
    await goTo(user, 'Builder');
    expect((await screen.findAllByText(/wfx_/)).length).toBeGreaterThan(0);
    expect(api.calls.length).toBe(before);
  });
});

describe('Work: request key for starts', () => {
  const keyOf = (c: { headers?: Record<string, string> }) => c.headers?.['Idempotency-Key'];
  const startCalls = (api: FakeXo) => posts(api, '/workflows/wf_1/executions');

  it("every start carries an Idempotency-Key in the platform's accepted shape", async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
    const key = keyOf(startCalls(api)[0]!);
    expect(key).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
  });

  it('a retry after an unclear failure reuses the SAME key, and only one run results', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.startBehavior = 'network_before';
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    await screen.findByText(/did not confirm whether this started/i);
    api.startBehavior = 'ok';
    await user.click(screen.getByRole('button', { name: /start this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
    const calls = startCalls(api);
    expect(calls).toHaveLength(2);
    expect(keyOf(calls[1]!)).toBe(keyOf(calls[0]!));
    expect(api.workflowRuns).toHaveLength(1);
  });

  it('when the first attempt DID arrive but the read is lagging, the same key gets the original run back — no duplicate', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.startBehavior = 'network_after_create'; // created, response lost
    api.hideRunsFromList = true; // and the follow-up read does not show it yet
    const user = await analysed(api);
    await goTo(user, 'Work');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    await screen.findByText(/found no run yet/i);
    expect(api.workflowRuns).toHaveLength(1);
    api.startBehavior = 'ok';
    await user.click(screen.getByRole('button', { name: /start this process/i }));
    await waitFor(() => expect(startCalls(api)).toHaveLength(2));
    expect(keyOf(startCalls(api)[1]!)).toBe(keyOf(startCalls(api)[0]!));
    expect(api.workflowRuns).toHaveLength(1); // the platform answered the retry with the original run
  });

  it('after a definite refusal the next start is a new intent with a new key', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await analysed(api);
    await goTo(user, 'Work');
    const start = await screen.findByRole('button', { name: /start this process/i });
    api.denyNextStart = true;
    await user.click(start);
    await screen.findByText('Some steps need approval first');
    await user.click(await screen.findByRole('button', { name: /start this process/i }));
    await screen.findByRole('button', { name: /approve this step/i });
    const [a, b] = startCalls(api);
    expect(keyOf(a!)).toBeDefined();
    expect(keyOf(b!)).not.toBe(keyOf(a!));
  });
});
