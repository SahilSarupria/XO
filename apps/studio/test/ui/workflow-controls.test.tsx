import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, openWorkflow } from './nav';

type U = ReturnType<typeof userEvent.setup>;

async function analysed(api: FakeXo): Promise<U> {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await user.click(screen.getByRole('button', { name: /^my xos/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await openScreen(user, 'Work');
  await waitFor(() => expect(document.querySelector('[data-wf-open]')).not.toBeNull());
  return user;
}
const approved = () => {
  const api = new FakeXo();
  api.approvals.all = true;
  return api;
};
const cards = () => screen.getByRole('list', { name: 'Workflows' });
const dialog = () => screen.getByRole('dialog');

describe('the workspace pause', () => {
  it('asks first and says what stops, then pauses everything, blocks a start with the reason, and resumes with one click', async () => {
    const api = approved();
    const user = await analysed(api);
    expect(screen.getByText(/everything is running normally/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Pause everything' }));
    const ask = screen.getByRole('alertdialog');
    expect(within(ask).getByText(/not by hand, not by a webhook or schedule, and not from a saved draft/i)).toBeInTheDocument();
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(api.controls.paused).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Pause everything' }));
    await user.type(screen.getByPlaceholderText(/checking a bad batch/i), 'Investigating');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pause everything' }));
    expect(await screen.findByText(/everything is paused\./i)).toBeInTheDocument();
    expect(screen.getByText(/reason: investigating/i)).toBeInTheDocument();
    expect(api.controls.paused).toBe(true);

    await openWorkflow(user);
    const start = within(dialog()).getByRole('button', { name: /start this process/i });
    expect(start).toBeDisabled();
    expect(within(dialog()).getByText(/everything is paused for this workspace/i)).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Resume everything' }));
    expect(await screen.findByText(/everything is running normally/i)).toBeInTheDocument();
    expect(api.controls.paused).toBe(false);
  });

  it('a role without manage cannot pause, and is told why', async () => {
    const api = approved();
    api.studio.role = 'publisher';
    await analysed(api);
    const pause = screen.getByRole('button', { name: 'Pause everything' });
    expect(pause).toBeDisabled();
    expect(pause).toHaveAttribute('title', expect.stringMatching(/does not include pausing everything/i));
  });

  it('on a platform that does not report controls, the page has no mode, no triggers and no pause line, and still works', async () => {
    const api = approved();
    api.supportsControls = false;
    const user = await analysed(api);
    expect(screen.queryByText(/everything is running normally/i)).not.toBeInTheDocument();
    await openWorkflow(user);
    expect(within(dialog()).queryByRole('region', { name: 'Workflow controls' })).not.toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /start this process/i })).toBeEnabled();
  });
});

describe('mode: draft, practising (shadow), live, paused', () => {
  it('practising needs approved rules, runs as practice, and the card and panel say so', async () => {
    const unapproved = new FakeXo();
    const u1 = await analysed(unapproved);
    await openWorkflow(u1);
    const blocked = within(dialog()).getByRole('button', { name: 'Start practising' });
    expect(blocked).toBeDisabled();
    expect(within(dialog()).getAllByText(/approve every rule first/i).length).toBeGreaterThan(0);
  });

  it('start practising → a practice run stops before the person step, asks nobody, and appears under practice results', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Start practising' }));
    expect(await within(dialog()).findByText(/practising: it carries out the steps xo can/i)).toBeInTheDocument();
    expect(api.controls.mode).toBe('shadow');
    await user.click(within(dialog()).getByRole('button', { name: 'Start a practice run' }));
    // A practice run does not create a task, so we stay on the Workflows page.
    expect(await within(dialog()).findByText(/1 practice run: 0 could be done without a person, 1 stopped/i)).toBeInTheDocument();
    expect(within(dialog()).getByText(/would stop at: review not covered/i)).toBeInTheDocument();
    expect(api.workflowRuns[0]?.pendingHumanTask).toBeUndefined();
  });

  it('a reviewer judges a practice run and sees how often they agreed, without it being called accuracy', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Start practising' }));
    await user.click(await within(dialog()).findByRole('button', { name: 'Start a practice run' }));
    await within(dialog()).findByText(/would stop at/i);
    await user.click(within(dialog()).getByRole('button', { name: 'A person would handle it' }));
    expect(await within(dialog()).findByText(/you judged 1, and agreed with what xo did on 1 of them/i)).toBeInTheDocument();
    expect(within(dialog()).getByText(/not a measure of accuracy/i)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'A person would handle it' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog()).getByRole('button', { name: 'No person needed' }));
    expect(await within(dialog()).findByText(/agreed with what xo did on 0 of them/i)).toBeInTheDocument();
  });

  it('going live is disabled with the missing items until it is signed off, limited and practised; then it asks first and goes live', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Start practising' }));
    const live = await within(dialog()).findByRole('button', { name: 'Go live…' });
    expect(live).toBeDisabled();
    expect(
      within(dialog()).getByText(/not ready to go live: .*signed this version off.*no daily limit.*not practised/i),
    ).toBeInTheDocument();

    await user.click(within(dialog()).getByRole('button', { name: 'Sign off this version' }));
    expect(await within(dialog()).findByText(/signed off by sally/i)).toBeInTheDocument();
    expect(within(dialog()).getByText(/a recorded sign-off, not a cryptographic signature/i)).toBeInTheDocument();
    await user.type(within(dialog()).getByLabelText('Daily limit'), '5');
    await user.click(within(dialog()).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog()).findByText('At most 5 runs a day')).toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: 'Start a practice run' }));
    await within(dialog()).findByText(/1 practice run/i);

    const ready = within(dialog()).getByRole('button', { name: 'Go live…' });
    await waitFor(() => expect(ready).toBeEnabled());
    await user.click(ready);
    const ask = within(dialog()).getByRole('alertdialog');
    expect(within(ask).getByText(/its runs are real: they ask real people to decide/i)).toBeInTheDocument();
    expect(api.controls.mode).toBe('shadow'); // nothing changed until confirmed
    await user.click(within(ask).getByRole('button', { name: 'Go live' }));
    await waitFor(() => expect(api.controls.mode).toBe('live'));
    await user.keyboard('{Escape}');
    expect(within(cards()).getByText('Live')).toBeInTheDocument();
  });

  it("pausing one workflow blocks its start with the platform's reason, and resuming returns it to practice", async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Pause' }));
    expect(await within(dialog()).findByText(/paused: nothing can start it/i)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /start this process/i })).toBeDisabled();
    expect(within(dialog()).getByText(/this workflow is paused\. resume it above first/i)).toBeInTheDocument();
    await user.click(within(dialog()).getByRole('button', { name: 'Resume practising' }));
    await waitFor(() => expect(api.controls.mode).toBe('shadow'));
  });

  it('a refusal from the platform is shown in its own words, not hidden', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    // The platform decides: practising needs approved rules and a runnable workflow.
    api.workflowExecutable = false;
    await user.click(within(dialog()).getByRole('button', { name: 'Start practising' }));
    expect(await within(dialog()).findByText(/cannot move to shadow yet/i)).toBeInTheDocument();
    expect(api.controls.mode).toBe('draft');
  });

  it('a viewer sees every control disabled, with the reason', async () => {
    const api = approved();
    api.studio.role = 'viewer';
    const user = await analysed(api);
    await openWorkflow(user);
    expect(within(dialog()).getByRole('button', { name: 'Start practising' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: 'Save limit' })).toBeDisabled();
    expect(within(dialog()).getByRole('button', { name: 'Sign off this version' })).toBeDisabled();
    expect(within(dialog()).getByText(/viewer access does not include changing this workflow/i)).toBeInTheDocument();
  });
});

describe('daily limit', () => {
  it('rejects a bad number before asking the platform, and shows how many runs have started today', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    const input = within(dialog()).getByLabelText('Daily limit');
    await user.type(input, '0');
    await user.click(within(dialog()).getByRole('button', { name: 'Save limit' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(/whole number from 1 to 100000/i);
    expect(api.controls.cap).toBeUndefined();
    expect(within(dialog()).getByText(/0 runs started today \(utc\), practice runs included/i)).toBeInTheDocument();
  });

  it('a start over the limit is blocked up front, and the card says so', async () => {
    const api = approved();
    api.controls.cap = 1;
    api.workflowRuns.push({
      workflowExecutionId: 'wfx_old',
      workflowId: 'wf_1',
      compilationId: 'x',
      status: 'succeeded',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workflowName: 'x',
      revision: 1,
      workspaceId: 'w',
      identityId: 'i',
      input: {},
      currentStepIndex: null,
      completedStepExecutionIds: [],
    });
    const user = await analysed(api);
    expect(within(cards()).getByText('Daily limit reached')).toBeInTheDocument();
    await openWorkflow(user);
    expect(within(dialog()).getByRole('button', { name: /start this process/i })).toBeDisabled();
    expect(within(dialog()).getByText(/it has reached its limit of 1 run today/i)).toBeInTheDocument();
  });
});

describe('how it starts', () => {
  it('a webhook shows how to call it, and waits (and says so) until the workflow is practising or live', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    await user.click(within(dialog()).getByRole('checkbox', { name: /start it from a webhook/i }));
    expect(await within(dialog()).findByText(/POST \/workspaces\/.+\/workflows\/wf_1\/webhook/)).toBeInTheDocument();
    expect(within(dialog()).getByText(/there is no separate secret/i)).toBeInTheDocument();
    expect(api.controls.webhook).toBe(true);
    await user.keyboard('{Escape}');
    expect(within(cards()).getByText(/webhook/i)).toBeInTheDocument();
    expect(within(cards()).getByText('(waiting)')).toBeInTheDocument();
  });

  it('a schedule checks its minutes and its JSON before asking, then shows as waiting with its interval', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    const minutes = within(dialog()).getByLabelText('Minutes between scheduled runs');
    await user.clear(minutes);
    await user.type(minutes, '3');
    await user.click(within(dialog()).getByRole('button', { name: 'Turn on schedule' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(/from 5 to 10080/i);
    await user.clear(minutes);
    await user.type(minutes, '30');
    await user.click(within(dialog()).getByLabelText('Input for each scheduled run'));
    await user.paste('[1,2]');
    await user.click(within(dialog()).getByRole('button', { name: 'Turn on schedule' }));
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(/must be a json object/i);
    expect(api.controls.schedule).toBeUndefined();
    const box = within(dialog()).getByLabelText('Input for each scheduled run');
    await user.clear(box);
    await user.click(box);
    await user.paste('{"claim_amount": 100}');
    await user.click(within(dialog()).getByRole('button', { name: 'Turn on schedule' }));
    await waitFor(() => expect(api.controls.schedule).toMatchObject({ everyMinutes: 30, input: { claim_amount: 100 } }));
    await user.keyboard('{Escape}');
    expect(within(cards()).getByText(/every 30 minutes/i)).toBeInTheDocument();
    expect(within(cards()).getByText('(waiting)')).toBeInTheDocument();
  });
});

describe('the needs-you card for practice', () => {
  it('asks for a judgement on practice cases nobody has judged, and opens the workflow', async () => {
    const api = approved();
    const user = await analysed(api);
    await openWorkflow(user);
    await user.click(within(dialog()).getByRole('button', { name: 'Start practising' }));
    await user.click(await within(dialog()).findByRole('button', { name: 'Start a practice run' }));
    await within(dialog()).findByText(/would stop at/i);
    await user.keyboard('{Escape}');
    const need = await screen.findByRole('region', { name: '1 thing needs you' });
    expect(within(need).getByText(/1 practice case is waiting for your judgement/i)).toBeInTheDocument();
    await user.click(within(need).getByRole('button', { name: 'Review cases' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
