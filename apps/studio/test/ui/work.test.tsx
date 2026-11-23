import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, setDetailLevel, findStart, openWorkflow } from './nav';

type U = ReturnType<typeof userEvent.setup>;

async function open(api: FakeXo): Promise<U> {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

/** Uploads + analyses a document in Sources. Leaves the user in Sources > Rules. */
async function analysed(api: FakeXo): Promise<U> {
  const user = await open(api);
  await user.click(screen.getByRole('button', { name: /^my xos/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  return user;
}

const goTo = (user: U, name: RegExp | string) => openScreen(user, name);
const posts = (api: FakeXo, suffix: string) => api.calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));

describe('shell stays business-neutral', () => {
  it('uses task-oriented navigation with no industry vocabulary', async () => {
    const api = new FakeXo();
    await open(api);
    const nav = screen.getByRole('navigation', { name: /workspace sections/i });
    expect(
      within(nav)
        .getAllByRole('button')
        .filter((b) => b.classList.contains('nav-item'))
        .map((b) => b.querySelector('.nav-label')?.textContent),
      // UW-12b (ADR 0052): 'What XO knows' is a new screen after Knowledge, so this list gains one name; nothing else moved.
    ).toEqual(['Home', 'Workflows', 'My XOs', 'Inbox', 'Library', 'Connect', 'Knowledge', 'What XO knows', 'Activity', 'Audit log']);
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
});

describe('Start work', () => {
  it('offers only real actions: no free-text request box, and no browser-only goal note', async () => {
    await open(new FakeXo());
    const start = screen.getByRole('region', { name: 'Start work' });
    expect(within(start).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/what are you trying to achieve/i)).not.toBeInTheDocument();
    expect(within(start).getByText(/does not take free-text requests/i)).toBeInTheDocument();
  });

  it('in an empty workspace the primary action leads to adding a document, and sends no request', async () => {
    const api = new FakeXo();
    const user = await open(api);
    const before = api.calls.length;
    await user.click(within(screen.getByRole('region', { name: 'Start work' })).getByRole('button', { name: 'Add your first document' }));
    expect(await screen.findByRole('heading', { name: 'Context' })).toBeInTheDocument();
    expect(document.getElementById('file-upload')).not.toBeNull();
    expect(api.calls.slice(before).filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('after an analysis it recommends reviewing what XO found, and that opens the rules, not the documents', async () => {
    const user = await analysed(new FakeXo());
    await goTo(user, 'Home');
    const start = await screen.findByRole('region', { name: 'Start work' });
    await user.click(within(start).getByRole('button', { name: 'Review what XO found' }));
    expect(await screen.findByRole('heading', { name: 'Review' })).toBeInTheDocument();
  });

  it('never offers Start a process while nothing can actually be started', async () => {
    const user = await analysed(new FakeXo());
    await goTo(user, 'Home');
    const start = await screen.findByRole('region', { name: 'Start work' });
    expect(within(start).queryByRole('button', { name: 'Start a process' })).not.toBeInTheDocument();
  });
});

describe('Work: starting', () => {
  it('lists the steps, says approvals are missing, and does not offer a usable Start', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await goTo(user, 'Work');
    await openWorkflow(user);
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
    await openWorkflow(user);
    expect(screen.getByRole('button', { name: /start this process/i })).toBeDisabled();
  });
});

async function withWaitingRun(api: FakeXo): Promise<U> {
  api.approvals.all = true;
  const user = await analysed(api);
  // ADR 0052: Studio cannot start a composed run any more; this is one the platform already holds, waiting for a person.
  await api.seedHistoricRun();
  await goTo(user, 'Tasks');
  await screen.findByRole('button', { name: /approve this step/i });
  return user;
}

describe('Tasks and Activity', () => {
  it('shows an empty state when nothing is waiting', async () => {
    const api = new FakeXo();
    const user = await open(api);
    await goTo(user, /^tasks/i);
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
  });
});
