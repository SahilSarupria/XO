/**
 * S1-0 — the truth fixes. Activity lists runs on the workflow runtime (F1) and no longer calls the audit log "planned"; a start
 * shows its run in the workflow's panel at once (F2); Home has no fake templates and the shared screens name no industry (F3);
 * stale copy is gone (F8); the Inbox count includes work waiting on the workflow runtime.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { findStart, openScreen } from './nav';

const INDUSTRY_WORDS = /\b(claims?|policy holder|insurer|premiums?|renewals?|patients?|invoices?|underwrit\w*)\b/i;

async function signIn(api: FakeXo) {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
}

async function analysed(api: FakeXo) {
  const user = await signIn(api);
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

describe('S1-0 truth fixes', () => {
  it('F1: Activity lists a run on the workflow runtime with its state in plain words, and no stale audit notice', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    const user = await analysed(api);
    await user.click(await findStart(user));
    await screen.findByText(/started on the workflow runtime/i);
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    await openScreen(user, 'Activity');
    const runs = await screen.findByRole('list', { name: 'Runs' });
    expect(within(runs).getByRole('heading', { name: 'Record before payment' })).toBeInTheDocument();
    expect(within(runs).getByText('Waiting for a person (1 decision)')).toBeInTheDocument();
    expect(within(runs).getByRole('button', { name: /open in the inbox: record before payment/i })).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been run yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/planned \(P1\.0\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not an audit record/i)).not.toBeInTheDocument();
  });

  it('F1: an empty Activity explains what will appear and points to no screen that does not exist', async () => {
    const api = new FakeXo();
    const user = await signIn(api);
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops' });
    await openScreen(user, 'Activity');
    expect(await screen.findByText('Nothing has been run yet')).toBeInTheDocument();
    expect(screen.getByText(/when a workflow runs, it appears here/i)).toBeInTheDocument();
    expect(screen.queryByText(/approve the rules xo found in sources/i)).not.toBeInTheDocument();
  });

  it('F1: when the run list fails to load, Activity says it cannot tell and never claims nothing has been run', async () => {
    const api = new FakeXo();
    api.failing.add('/runs?limit=50');
    const user = await signIn(api);
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops' });
    await openScreen(user, 'Activity');
    expect(await screen.findByText(/the list of runs could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText('Nothing has been run yet')).not.toBeInTheDocument();
  });

  it('F2: after a start the panel shows the run at once and offers to decide it, not "Nothing is running"', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    const user = await analysed(api);
    await user.click(await findStart(user));
    const panel = screen.getByRole('dialog');
    await waitFor(() => expect(within(panel).getByText(/waiting for a person \(1 decision\), started/i)).toBeInTheDocument());
    expect(within(panel).queryByText(/nothing is running/i)).not.toBeInTheDocument();
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Decide in the Inbox' })).toBeEnabled());
    expect(within(panel).queryByRole('button', { name: /start this workflow/i })).not.toBeInTheDocument();
  });

  it('F2: after a start the workflow card says it is waiting for a person, not "Not run yet" or "All clear"', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    const user = await analysed(api);
    await user.click(await findStart(user));
    await screen.findByText(/started on the workflow runtime/i);
    await user.click(screen.getByRole('button', { name: 'Close details' }));
    const card = document.querySelector<HTMLElement>('[data-wf-open]')!.closest('.wc') as HTMLElement;
    await waitFor(() => expect(card.textContent).toMatch(/waiting for a person/i));
    expect(card.textContent).toMatch(/a person must decide/i);
    expect(card.textContent).not.toMatch(/not run yet|all clear/i);
  });

  it('the Inbox count includes work waiting on the workflow runtime', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    const user = await analysed(api);
    await user.click(await findStart(user));
    await screen.findByText(/started on the workflow runtime/i);
    await waitFor(() => expect(screen.getByRole('button', { name: /^Inbox/ })).toHaveAccessibleName(/1 need attention/i));
  });

  it('F3: an empty Home offers one real next step, no template grid, and names no industry', async () => {
    const api = new FakeXo();
    const user = await signIn(api);
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops' });
    await screen.findByRole('region', { name: 'Start with how your team already works' });
    const work = screen.getByRole('region', { name: 'Start work' });
    expect(within(work).getByRole('button', { name: 'Add your first document' })).toBeInTheDocument();
    expect(screen.queryByText(/templates are coming/i)).not.toBeInTheDocument();
    for (const fake of ['Process claims', 'Review contracts', 'Draft renewals', 'Triage my inbox'])
      expect(screen.queryByText(fake)).not.toBeInTheDocument();
    expect(document.querySelector('.template-grid')).toBeNull();
    expect(document.querySelector('main')!.textContent).not.toMatch(INDUSTRY_WORDS);
  });

  it('F3/F8: sign-in and the first workspace make no claim the product cannot back and name no industry', async () => {
    const api = new FakeXo();
    window.history.replaceState(null, '', '#/home');
    render(withShell(<App fetchImpl={api.fetch} />));
    await screen.findByLabelText(/access key/i);
    expect(screen.queryByText(/independently verifiable/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(INDUSTRY_WORDS);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const name = await screen.findByLabelText(/workspace name/i);
    expect(name).toHaveAttribute('placeholder', 'e.g. Operations');
    expect(document.body.textContent).not.toMatch(INDUSTRY_WORDS);
  });
});
