import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;
const posts = (api: FakeXo, suffix: string) => api.calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));
const go = (user: U, name: RegExp | string) => openScreen(user, name);

async function withWaitingRun(api: FakeXo): Promise<U> {
  api.approvals.all = true;
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
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
  return user;
}
const noteBox = () => screen.getByRole('textbox', { name: /saved with your decision/i });

describe('optional decision notes', () => {
  it('are collapsed by default and never required', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    expect(screen.getByText(/add a note \(optional\)/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    await screen.findAllByText(/step 2 of 2/i);
    expect((posts(api, '/resume')[0]!.body as Record<string, unknown>)['data']).toBeUndefined(); // no note, no data
  });

  it('are sent with the decision as data.note, trimmed, and shown from what the platform returns', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByText(/add a note \(optional\)/i));
    await user.type(noteBox(), '  Checked against the March statement  ');
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    await screen.findAllByText(/step 2 of 2/i);
    expect(posts(api, '/resume')[0]!.body).toMatchObject({ decision: 'approve', data: { note: 'Checked against the March statement' } });
    expect(await screen.findByText(/note from sally: checked against the march statement/i)).toBeInTheDocument();
    // the note box is cleared for the next step
    expect(screen.getByRole('textbox', { name: /saved with your decision/i })).toHaveValue('');
  });

  it('survives a reload: shown in Activity from the platform record, not from the browser', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByText(/add a note \(optional\)/i));
    await user.type(noteBox(), 'Looks right');
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    await screen.findAllByText(/step 2 of 2/i);
    cleanup();
    window.localStorage.clear();
    window.sessionStorage.clear();
    const u2 = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await u2.type(screen.getByLabelText(/access key/i), api.validKey);
    await u2.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Ops' });
    await openScreen(u2, 'Activity');
    expect(await screen.findByText(/note from sally: looks right/i)).toBeInTheDocument();
  });

  it('rejects an over-long note locally, sends nothing, and keeps the text', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByText(/add a note \(optional\)/i));
    await user.click(noteBox());
    await user.paste('x'.repeat(501));
    expect(screen.getByText(/keep the note to 500 characters or fewer/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(posts(api, '/resume')).toHaveLength(0);
    expect(noteBox()).toHaveValue('x'.repeat(501));
  });

  it('keeps what was typed through a conflict, and does not apply or record it', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByText(/add a note \(optional\)/i));
    await user.type(noteBox(), 'my reasoning');
    api.bumpRevisionBeforeResume = true;
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText('This process has changed')).toBeInTheDocument();
    expect(noteBox()).toHaveValue('my reasoning');
    expect(api.executions.some((e) => e.humanTask?.decisionData !== undefined)).toBe(false);
  });

  it('keeps what was typed through an unclear failure and does not resend', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByText(/add a note \(optional\)/i));
    await user.type(noteBox(), 'still here');
    api.resumeBehavior = 'network_before';
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText(/nothing was resent/i)).toBeInTheDocument();
    expect(noteBox()).toHaveValue('still here');
  });

  it('are also available on a reject', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByText(/add a note \(optional\)/i));
    await user.type(noteBox(), 'wrong amount');
    await user.click(screen.getByRole('button', { name: /reject and stop/i }));
    expect(await screen.findByText(/note from sally: wrong amount/i)).toBeInTheDocument();
    expect(posts(api, '/resume')[0]!.body).toMatchObject({ decision: 'reject', data: { note: 'wrong amount' } });
  });

  it('a platform validation error is shown, not swallowed, and the note stays', async () => {
    const api = new FakeXo();
    const user = await withWaitingRun(api);
    await user.click(screen.getByText(/add a note \(optional\)/i));
    await user.type(noteBox(), 'ok');
    api.rejectDecisionData = true; // the platform's own rules differ from ours
    await user.click(screen.getByRole('button', { name: /approve this step/i }));
    expect(await screen.findByText(/could not read that decision/i)).toBeInTheDocument();
    expect(noteBox()).toHaveValue('ok');
  });
});
