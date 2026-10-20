import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;
const go = (user: U, name: RegExp | string) => openScreen(user, name);
const startRegion = () => screen.getByRole('region', { name: 'Start work' });

async function connect(api: FakeXo, fetchImpl: typeof api.fetch = api.fetch): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={fetchImpl} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  return user;
}

async function open(api: FakeXo): Promise<U> {
  const user = await connect(api);
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

async function analyse(user: U): Promise<void> {
  await go(user, /^setup/i);
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
}

/** Starts a process, lets `change` happen to it on the platform, then returns in a fresh session. */
async function returnAfter(api: FakeXo, change: (run: Record<string, any>) => void): Promise<U> {
  api.approvals.all = true;
  let user = await open(api);
  await analyse(user);
  await go(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /start this process/i }));
  await screen.findByRole('button', { name: /approve this step/i });
  change(api.workflowRuns[0]!);
  cleanup();
  window.history.replaceState(null, '', window.location.pathname);
  user = await connect(api);
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

const fail = (run: Record<string, any>) => {
  const i = run.currentStepIndex as number;
  run.status = 'failed';
  run.errorMessage = 'The step could not be completed.';
  run.steps[i].status = 'failed';
  run.revision += 1;
  delete run.pendingHumanTask;
  delete run.currentStepExecutionId;
};

describe('Home: loading and partial data are never shown as "nothing here"', () => {
  it('shows a loading state, not the first-run prompt, until the lists have answered', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const first = await open(api);
    await analyse(first);
    cleanup();
    window.history.replaceState(null, '', window.location.pathname);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: typeof api.fetch = async (input, init) => {
      if (/\/sources$/.test(input)) await gate;
      return api.fetch(input, init);
    };
    await connect(api, slow);
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent(/loading your workspace/i);
    expect(screen.queryByRole('button', { name: 'Add your first document' })).not.toBeInTheDocument();
    release();
    // Once it has answered, the workspace that DOES have a document is not told to add its first one.
    expect(
      await within(await screen.findByRole('region', { name: 'Start work' })).findByRole('button', { name: 'Start a process' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add your first document' })).not.toBeInTheDocument();
  });

  it('when runs fail to load, says Home may be incomplete and offers only the step that does not depend on them', async () => {
    const api = new FakeXo();
    api.failing.add('/workflow-executions');
    await open(api);
    const start = await screen.findByRole('region', { name: 'Start work' });
    expect(within(start).getByText(/could not be loaded, so xo is only offering/i)).toBeInTheDocument();
    expect(within(start).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText(/may not show everything that needs you/i)).toBeInTheDocument();
    expect(within(start).queryByText(/not available right now/i)).not.toBeInTheDocument(); // no guessed reasons
  });
});

describe('Start work: availability is explained from real state', () => {
  it('lists what is not available and why, and the reasons match what is offered', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await analyse(user);
    await go(user, 'Home');
    const start = await screen.findByRole('region', { name: 'Start work' });
    const reasons = within(start).getByRole('list', { name: 'Not available right now', hidden: true });
    expect(within(reasons).getByText(/nothing is waiting for a decision/i)).toBeInTheDocument();
    expect(within(reasons).getByText(/needs its rules approved first|need their rules approved first/i)).toBeInTheDocument();
    expect(within(start).queryByRole('button', { name: /start a process/i })).not.toBeInTheDocument();
  });

  it('is operable from the keyboard: Enter on the recommended action opens the right screen', async () => {
    const user = await open(new FakeXo());
    const primary = within(startRegion()).getByRole('button', { name: 'Add your first document' });
    primary.focus();
    expect(primary).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Context' })).toBeInTheDocument();
  });
});

describe('Workspaces: switching keeps every request inside the chosen workspace', () => {
  it('after opening another workspace, its data is requested under that workspace only', async () => {
    const api = new FakeXo();
    const user = await open(api);
    const nav = () => screen.getByRole('navigation', { name: /workspace sections/i });
    await user.click(within(nav()).getByRole('button', { name: 'Workspaces' }));
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'New workspace' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Second');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Second', level: 1 });
    const [first, second] = api.workspaces;
    expect(second?.name).toBe('Second');
    api.calls.length = 0;
    await user.click(within(nav()).getByRole('button', { name: 'Workspaces' }));
    await user.click(await screen.findByRole('button', { name: 'Open Ops' }));
    await screen.findByRole('heading', { name: 'Ops', level: 1 });
    await waitFor(() => expect(api.calls.some((c) => c.path.startsWith(`/workspaces/${first!.workspaceId}/`))).toBe(true));
    expect(api.calls.some((c) => c.path.startsWith(`/workspaces/${second!.workspaceId}/`))).toBe(false);
  });
});

describe('Runs & History: failed and interrupted work is described accurately', () => {
  it('a failed process is shown as failed everywhere, with no retry or continue offered', async () => {
    const api = new FakeXo();
    const user = await returnAfter(api, fail);
    expect(await screen.findByRole('heading', { name: 'Did not complete' })).toBeInTheDocument();
    expect(screen.queryByText('Stopped — can be continued')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /see what happened/i }));
    expect(await screen.findByRole('heading', { name: 'Activity', level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/cannot be retried or continued/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry|continue|replay|restart/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^inbox$/i })).toBeInTheDocument(); // nothing needs attention
  });

  it('filters history by what actually happened, and an empty group says so', async () => {
    const api = new FakeXo();
    const user = await returnAfter(api, fail);
    await go(user, 'Activity');
    const filter = await screen.findByRole('group', { name: 'Filter processes' });
    expect(within(filter).getByRole('button', { name: /did not complete.*1/i })).toBeInTheDocument();
    await user.click(within(filter).getByRole('button', { name: /^finished/i }));
    expect(screen.getByText(/no processes in this group/i)).toBeInTheDocument();
    await user.click(within(filter).getByRole('button', { name: /^did not complete/i }));
    expect(screen.queryByText(/no processes in this group/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('Did not complete').length).toBeGreaterThan(1);
  });

  it('an interrupted process links from Home to Tasks, and from Activity to Tasks, where it can really be continued', async () => {
    const api = new FakeXo();
    const user = await returnAfter(api, (r) => api.interruptRun(r));
    await user.click(await screen.findByRole('button', { name: /review in tasks/i }));
    expect(await screen.findByRole('button', { name: /continue this process/i })).toBeInTheDocument();
    await go(user, 'Activity');
    await user.click(await screen.findByRole('button', { name: /open .* in tasks/i }));
    expect(window.location.hash).toBe('#/tasks');
    expect(await screen.findByRole('button', { name: /continue this process/i })).toBeInTheDocument();
  });

  it('Tasks does not say "nothing is waiting" when decisions could not be loaded', async () => {
    const api = new FakeXo();
    api.failing.add('/workflow-executions');
    const user = await open(api);
    await go(user, 'Tasks');
    expect(await screen.findByText(/decisions could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting for you')).not.toBeInTheDocument();
  });

  it('Activity does not say "nothing has been run" when history could not be loaded', async () => {
    const api = new FakeXo();
    api.failing.add('/workflow-executions');
    const user = await open(api);
    await go(user, 'Activity');
    expect(await screen.findByText(/run history could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been run yet')).not.toBeInTheDocument();
  });

  it('an empty Tasks screen points to past activity', async () => {
    const user = await open(new FakeXo());
    await go(user, 'Tasks');
    await user.click(await screen.findByRole('button', { name: /see past activity/i }));
    expect(window.location.hash).toBe('#/activity');
  });
});

describe('visual-acceptance fixes', () => {
  it('Home offers exactly one primary action: Start work. Cards beneath it are secondary', async () => {
    const api = new FakeXo();
    await returnAfter(api, () => {}); // a process is waiting for a decision
    const start = await screen.findByRole('region', { name: 'Start work' });
    expect(
      within(start)
        .getAllByRole('button')
        .filter((b) => b.classList.contains('btn-primary')),
    ).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(Array.from(main.querySelectorAll('button.btn-primary'))).toHaveLength(1);
    expect(within(main).getByRole('button', { name: /review this decision/i })).toHaveClass('btn-secondary');
  });

  it('Activity filters look like filters (chips), and there are no page tabs above them', async () => {
    const user = await returnAfter(new FakeXo(), () => {});
    await go(user, 'Activity');
    const filter = await screen.findByRole('group', { name: 'Filter processes' });
    expect(screen.queryByRole('group', { name: /runs and history views/i })).not.toBeInTheDocument(); // Inbox and Activity are sidebar sections now
    expect(filter.querySelectorAll('.chip')).toHaveLength(5);
    expect(filter.querySelectorAll('.tab')).toHaveLength(0);
    // Every chip still reports its count to assistive technology, including zero.
    expect(within(filter).getByRole('button', { name: /^running.*0/i })).toBeInTheDocument();
  });

  it('the workspace-name crumb is marked as droppable on narrow screens; the page crumb never is', async () => {
    const user = await open(new FakeXo());
    await go(user, 'Workflows');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Ops').closest('li')).toHaveClass('crumb-low');
    expect(within(crumbs).getByText('Workflows').closest('li')).not.toHaveClass('crumb-low');
    expect(within(crumbs).getByText('Workspaces').closest('li')).not.toHaveClass('crumb-low');
  });
});
