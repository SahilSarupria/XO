import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

const EXE = 'exe_pending_1';

/** A platform with one standalone rule waiting for a person — in the execution list AND in the platform's inbox. */
function withPendingTask(api: FakeXo, extra: { questions?: boolean } = {}) {
  api.executions.push({
    executionId: EXE,
    compilationId: 'cmp_1',
    capabilityId: 'cap_1',
    status: 'waiting_for_human',
    requestedAt: '2026-10-22T09:00:00.000Z',
    completedAt: '2026-10-22T09:00:02.000Z',
    input: {},
    humanTask: { status: 'pending' },
  } as never);
  api.studio.inbox.push({ executionId: EXE, title: 'Review not covered', state: 'needs_review', sourceFilename: 'policy.pdf' });
  if (extra.questions === true)
    api.studio.infoRequests.set(EXE, [
      { requestId: 'ir_1', question: 'Was there forced entry?', requestedBy: 'meera-identity', requestedAt: '2026-10-22T10:00:00.000Z' },
    ]);
}

async function openInbox(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops', level: 1 });
  await user.click(screen.getByRole('button', { name: /^Inbox/ }));
  await screen.findByRole('region', { name: 'Inbox' });
  return user;
}
const resolves = (api: FakeXo) => api.calls.filter((c) => c.path.endsWith('/resolve'));
beforeEach(() => window.localStorage.clear());

describe('Inbox: questions about a waiting item', () => {
  it('asking records a question and nothing else: the item stays waiting and nothing is decided', async () => {
    const api = new FakeXo();
    withPendingTask(api);
    const user = await openInbox(api);
    const thread = await screen.findByRole('region', { name: 'Questions about this' });
    expect(within(thread).getByText('No questions yet.')).toBeInTheDocument();
    await user.type(within(thread).getByLabelText('Ask for more information'), 'Was there forced entry?');
    await user.click(within(thread).getByRole('button', { name: 'Ask' }));
    expect(await within(thread).findByText('Was there forced entry?')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path.endsWith('/info-requests'))?.body).toEqual({ question: 'Was there forced entry?' });
    expect(resolves(api)).toHaveLength(0);
    expect(within(thread).getByText(/Asking does not decide or change anything/)).toBeInTheDocument();
    // the row now says a question is open, and the item is still under Needs review
    expect(await screen.findByText(/1 open question/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Needs review 1/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('answering records the answer once and clears the open-question count', async () => {
    const api = new FakeXo();
    withPendingTask(api, { questions: true });
    const user = await openInbox(api);
    expect(await screen.findByText(/1 open question/)).toBeInTheDocument();
    const thread = await screen.findByRole('region', { name: 'Questions about this' });
    await user.type(within(thread).getByLabelText('Answer'), 'Photos attached');
    await user.click(within(thread).getByRole('button', { name: 'Send answer' }));
    expect(await within(thread).findByText(/Photos attached/)).toBeInTheDocument();
    expect(api.calls.find((c) => c.path.endsWith('/answer'))?.body).toEqual({ answer: 'Photos attached' });
    expect(within(thread).queryByLabelText('Answer')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/open question/)).not.toBeInTheDocument());
  });

  it('roles: a Reviewer can ask but not answer or… a Publisher can answer but not ask or decide; a Viewer can do none, each with the reason', async () => {
    const reviewer = new FakeXo();
    reviewer.studio.role = 'reviewer';
    withPendingTask(reviewer, { questions: true });
    await openInbox(reviewer);
    let thread = await screen.findByRole('region', { name: 'Questions about this' });
    expect(within(thread).getByLabelText('Ask for more information')).toBeEnabled();
    expect(within(thread).getByLabelText('Answer')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve this step' })).toBeEnabled();
  });
  it('a Publisher can answer but not ask or decide', async () => {
    const publisher = new FakeXo();
    publisher.studio.role = 'publisher';
    withPendingTask(publisher, { questions: true });
    await openInbox(publisher);
    const thread = await screen.findByRole('region', { name: 'Questions about this' });
    expect(within(thread).getByLabelText('Answer')).toBeEnabled();
    expect(within(thread).getByLabelText('Ask for more information')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve this step' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve this step' })).toHaveAttribute(
      'title',
      expect.stringMatching(/Publisher access does not include approving or rejecting/),
    );
  });
  it('a Viewer can read the thread but do nothing, and the platform is never asked', async () => {
    const viewer = new FakeXo();
    viewer.studio.role = 'viewer';
    withPendingTask(viewer, { questions: true });
    await openInbox(viewer);
    const thread = await screen.findByRole('region', { name: 'Questions about this' });
    expect(within(thread).getByText('Was there forced entry?')).toBeInTheDocument();
    expect(within(thread).getByLabelText('Answer')).toBeDisabled();
    expect(within(thread).getByLabelText('Ask for more information')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve this step' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject this step' })).toBeDisabled();
    expect(viewer.calls.some((c) => c.method === 'POST' && /info-requests|resolve/.test(c.path))).toBe(false);
  });
  it('hiding is not authorization: a stale role hint that lets a Viewer try is refused by the platform and says why', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'admin';
    withPendingTask(api);
    const user = await openInbox(api);
    const thread = await screen.findByRole('region', { name: 'Questions about this' });
    await user.type(within(thread).getByLabelText('Ask for more information'), 'sneaky question');
    await user.click(within(thread).getByRole('button', { name: 'Ask' }));
    expect(await within(thread).findByRole('alert')).toHaveTextContent(/Your role does not allow this/);
    expect(api.studio.infoRequests.get(EXE) ?? []).toHaveLength(0);
  });
});

describe('Inbox: Done and notifications', () => {
  it('Done lists decided items with the decision and who made it, and the thread is read-only', async () => {
    const api = new FakeXo();
    api.studio.inbox.push({
      executionId: 'exe_done',
      title: 'Check exclusions',
      state: 'done',
      decision: 'approve',
      resolvedAt: '2026-10-21T12:00:00.000Z',
      resolverIdentityId: 'meera-identity',
      sourceFilename: 'policy.pdf',
    });
    api.studio.infoRequests.set('exe_done', [
      { requestId: 'ir_9', question: 'Proof of forced entry?', requestedBy: 'owner', requestedAt: '2026-10-21T10:00:00.000Z' },
    ]);
    const user = await openInbox(api);
    await user.click(await screen.findByRole('button', { name: /Done 1/ }));
    const list = await screen.findByRole('list', { name: 'Decided' });
    expect(within(list).getByText('Check exclusions')).toBeInTheDocument();
    expect(within(list).getByText(/Approved/)).toBeInTheDocument();
    expect(screen.getByText(/Decided by meera-identity/)).toBeInTheDocument();
    expect(screen.getByText('From policy.pdf')).toBeInTheDocument();
    const thread = await screen.findByRole('region', { name: 'Questions about this' });
    expect(within(thread).getByText('Proof of forced entry?')).toBeInTheDocument();
    expect(within(thread).getByText('Not answered.')).toBeInTheDocument();
    expect(within(thread).getByText(/no more questions can be asked/)).toBeInTheDocument();
    expect(within(thread).queryByLabelText('Ask for more information')).not.toBeInTheDocument();
  });

  it('notifications show what the platform recorded, can be marked read, and say they are in-app only', async () => {
    const api = new FakeXo();
    api.studio.notifications.push(
      { seq: 7, at: '2026-10-22T09:00:00.000Z', kind: 'escalation', event: 'workflow.started', read: false },
      { seq: 5, at: '2026-10-21T09:00:00.000Z', kind: 'run_failure', event: 'execution.created', read: true },
    );
    const user = await openInbox(api);
    const panel = await screen.findByRole('region', { name: /Notifications/ });
    expect(await within(panel).findByText('Something needs a person to decide')).toBeInTheDocument();
    expect(within(panel).getByText('A run failed')).toBeInTheDocument();
    expect(within(panel).getByText('1 new', { exact: false })).toBeInTheDocument();
    expect(within(panel).getByText(/does not send email or push notifications/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(within(panel).queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument());
    expect(api.calls.find((c) => c.path.endsWith('/notifications/read'))?.body).toEqual({ throughSeq: 7 });
  });

  it('no notifications is stated, not hidden', async () => {
    const api = new FakeXo();
    await openInbox(api);
    const panel = await screen.findByRole('region', { name: /Notifications/ });
    expect(await within(panel).findByText('No notifications.')).toBeInTheDocument();
  });

  it('if the platform’s inbox view cannot be loaded, waiting items still show and nothing is claimed about questions or Done', async () => {
    const api = new FakeXo();
    withPendingTask(api);
    api.failing.add('/inbox');
    await openInbox(api);
    expect(await screen.findByRole('list', { name: 'Waiting for a person' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Done/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/open question/)).not.toBeInTheDocument();
  });
});
