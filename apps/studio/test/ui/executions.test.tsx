import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;

const step = (id: string, order: number, name: string, status: string, executionId?: string) => ({
  stepId: `${id}#${order}`,
  order,
  capabilityId: id,
  capabilityName: name,
  status,
  ...(executionId !== undefined ? { executionId } : {}),
});
const mkRun = (cmp: string, n: string, status: string, steps: unknown[], createdAt: string, completedAt?: string) => ({
  workflowExecutionId: `wfx_${n}`,
  workspaceId: 'w',
  identityId: 'sally',
  initiator: { kind: 'human', id: 'sally' },
  compilationId: cmp,
  workflowId: 'wf_1',
  workflowName: 'Record before payment → Review not covered',
  revision: 2,
  status,
  input: {},
  steps,
  currentStepIndex: status === 'waiting_for_human' ? 1 : null,
  completedStepExecutionIds: [],
  createdAt,
  updatedAt: completedAt ?? createdAt,
  ...(completedAt !== undefined ? { completedAt } : {}),
});

async function withRuns(): Promise<{ api: FakeXo; user: U }> {
  const api = new FakeXo();
  api.approvals.all = true;
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await user.click(screen.getByRole('button', { name: /^my xos/i }));
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  const cmp = api.compilations[0]!.compilationId;
  api.workflowRuns.push(
    mkRun(cmp, 'aaaaaa01', 'succeeded', [step('cap_det', 0, 'Record before payment', 'succeeded', 'exe_a0'), step('cap_hitl', 1, 'Review not covered', 'succeeded', 'exe_a1')], '2026-10-19T10:00:00.000Z', '2026-10-19T10:00:01.200Z'),
    mkRun(cmp, 'bbbbbb02', 'failed', [step('cap_det', 0, 'Record before payment', 'failed', 'exe_b0'), step('cap_hitl', 1, 'Review not covered', 'pending')], '2026-10-19T11:00:00.000Z', '2026-10-19T11:00:00.800Z'),
    mkRun(cmp, 'dddddd04', 'running', [step('cap_det', 0, 'Record before payment', 'running', 'exe_d0'), step('cap_hitl', 1, 'Review not covered', 'pending')], '2026-10-20T10:00:00.000Z'),
    mkRun(cmp, 'cccccc03', 'waiting_for_human', [step('cap_det', 0, 'Record before payment', 'succeeded', 'exe_c0'), step('cap_hitl', 1, 'Review not covered', 'waiting_for_human', 'exe_c1')], '2026-10-20T09:00:00.000Z'),
  );
  api.executions.push(
    { executionId: 'exe_a0', compilationId: cmp, capabilityId: 'cap_det', status: 'succeeded', requestedAt: '2026-10-19T10:00:00.000Z', completedAt: '2026-10-19T10:00:00.700Z', input: { claim: { amount: 1200 } }, output: { decision: 'eligible', rules_matched: 6 } },
    { executionId: 'exe_b0', compilationId: cmp, capabilityId: 'cap_det', status: 'failed', requestedAt: '2026-10-19T11:00:00.000Z', completedAt: '2026-10-19T11:00:00.500Z', input: {}, errorMessage: 'missing required property claim' },
  );
  await openScreen(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /view graph of/i }));
  await screen.findByRole('region', { name: 'Workflow graph' });
  await user.click(screen.getByRole('tab', { name: 'Executions' }));
  await screen.findByRole('navigation', { name: 'Runs' });
  return { api, user };
}

describe('Executions', () => {
  it('lists this process’s runs newest first with the status the platform recorded, and a duration only where one was recorded', async () => {
    await withRuns();
    const runs = within(screen.getByRole('navigation', { name: 'Runs' })).getAllByRole('button');
    expect(runs.map((r) => r.textContent)).toEqual([
      'Run dddd04Running', // not finished: no duration
      'Run cccc03Waiting for a decision',
      'Run bbbb02Did not complete at Record before payment · 800 ms',
      'Run aaaa01Completed · 1.2 s',
    ]);
    expect(window.location.hash).toBe('#/executions');
  });

  it('shows the chosen run as a graph of its steps with their recorded outcome, and no timings that were not recorded', async () => {
    const { user } = await withRuns();
    await user.click(screen.getByRole('button', { name: /Run aaaa01/ }));
    const nodes = within(within(screen.getByRole('region', { name: 'Run graph' })).getByRole('list', { name: /steps in the order/i })).getAllByRole('button');
    expect(nodes[0]!.textContent).toContain('Record before payment');
    expect(nodes[0]!.textContent).toContain('Finished · 700 ms'); // from the execution's own timestamps
    expect(nodes[1]!.textContent).toContain('Finished'); // no execution recorded for this step: no time claimed
    expect(nodes[1]!.textContent).not.toMatch(/ms|\ds/);
    await user.click(screen.getByRole('button', { name: /Run bbbb02/ }));
    const failed = within(screen.getByRole('region', { name: 'Run graph' })).getAllByRole('button');
    expect(failed[0]).toHaveAttribute('data-state', 'failed');
    expect(failed[1]).toHaveAttribute('data-state', 'upcoming');
  });

  it('the drawer shows the step’s real output and input, and the events the platform recorded', async () => {
    const { user } = await withRuns();
    await user.click(screen.getByRole('button', { name: /Run aaaa01/ }));
    await user.click(within(screen.getByRole('region', { name: 'Run graph' })).getAllByRole('button')[0]!);
    const drawer = screen.getByRole('region', { name: 'Step details' });
    expect(within(drawer).getByRole('heading', { name: 'Record before payment' })).toBeInTheDocument();
    expect(within(drawer).getByText(/"decision": "eligible"/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('tab', { name: 'Input' }));
    expect(within(drawer).getByText(/"amount": 1200/)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('tab', { name: 'Trace' }));
    expect(within(drawer).getByText('Requested')).toBeInTheDocument();
    expect(within(drawer).getByText('Ended as succeeded')).toBeInTheDocument();
  });

  it('a step without a recorded execution says so, instead of showing made-up output', async () => {
    const { user } = await withRuns();
    await user.click(screen.getByRole('button', { name: /Run aaaa01/ }));
    await user.click(within(screen.getByRole('region', { name: 'Run graph' })).getAllByRole('button')[1]!);
    expect(within(screen.getByRole('region', { name: 'Step details' })).getByText(/no execution for this step/i)).toBeInTheDocument();
  });

  it('opens on the step that needs attention: the failed step shows the platform’s error, in the drawer and the trace', async () => {
    const { user } = await withRuns();
    await user.click(screen.getByRole('button', { name: /Run bbbb02/ }));
    const drawer = screen.getByRole('region', { name: 'Step details' });
    expect(within(drawer).getByRole('heading', { name: 'Record before payment' })).toBeInTheDocument();
    await user.click(within(drawer).getByRole('tab', { name: 'Trace' }));
    expect(within(drawer).getAllByText(/missing required property claim/).length).toBeGreaterThan(0);
  });

  it('the scrubber steps through the recorded order: nothing is reached at the start, everything at the end', async () => {
    const { user } = await withRuns();
    await user.click(screen.getByRole('button', { name: /Run aaaa01/ }));
    const graph = screen.getByRole('region', { name: 'Run graph' });
    const slider = within(graph).getByLabelText('Replay position') as HTMLInputElement;
    expect(slider.value).toBe('2');
    fireEvent.change(slider, { target: { value: '0' } });
    expect(within(graph).getAllByRole('button').filter((b) => b.classList.contains('wf-node')).map((b) => b.getAttribute('data-state'))).toEqual(['upcoming', 'upcoming']);
    expect(within(graph).getByRole('status')).toHaveTextContent(/move the slider or press play/i);
    fireEvent.change(slider, { target: { value: '1' } });
    expect(within(graph).getByRole('status')).toHaveTextContent(/step 1 of 2: record before payment finished/i);
    await user.click(within(graph).getByRole('button', { name: 'Play' }));
    expect(within(graph).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
  });

  it('with no runs, says so and points back to the Editor', async () => {
    const api = new FakeXo();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops' });
    await user.click(screen.getByRole('button', { name: /^my xos/i }));
    await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    await screen.findByText(/settlement amount must be recorded/i);
    window.location.hash = '#/executions';
    expect(await screen.findByText('No runs to show')).toBeInTheDocument();
    expect(screen.getByText('This process has not been run yet.')).toBeInTheDocument();
  });

  it('opening a running process from Home lands on that run, and a decision still goes to the Inbox', async () => {
    const { user } = await withRuns();
    window.location.hash = '#/home';
    const rows = await screen.findAllByRole('button', { name: /^Open Record before payment/ });
    const running = rows.find((r) => within(r).queryByText('Running') !== null)!;
    await user.click(running);
    await screen.findByRole('navigation', { name: 'Runs' });
    expect(screen.getByRole('button', { name: /Run dddd04/ })).toHaveAttribute('aria-pressed', 'true');
    window.location.hash = '#/home';
    const waiting = (await screen.findAllByRole('button', { name: /^Open Record before payment/ })).find((r) => within(r).queryByText('Needs review') !== null)!;
    await user.click(waiting);
    expect(window.location.hash).toBe('#/tasks');
  });
});
