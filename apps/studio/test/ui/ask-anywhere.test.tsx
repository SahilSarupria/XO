import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, workspaceReady } from './nav';

/** S1-3b: the Ask box on every screen, one typed answer per question. */
async function home(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  return user;
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(await screen.findByLabelText('Ask XO'), `${text}{enter}`);
  return screen.findByRole('dialog', { name: 'Ask XO conversation' });
}

describe('Ask XO answers, one kind at a time', () => {
  it('cannot: says why and what would make it possible, and changes nothing', async () => {
    const api = new FakeXo();
    api.studio.askAnswer = { kind: 'cannot', reason: 'Changing settings is done in Settings.', whatWouldHelp: 'Open Settings.' };
    const user = await home(api);
    const panel = await ask(user, 'delete everything');
    expect(await within(panel).findByText('Changing settings is done in Settings.')).toBeInTheDocument();
    expect(within(panel).getByText('Open Settings.')).toBeInTheDocument();
  });

  it('navigate: offers a button; choosing it opens the place and closes the conversation', async () => {
    const api = new FakeXo();
    api.studio.askAnswer = { kind: 'navigate', place: 'inbox', label: 'Inbox' };
    const user = await home(api);
    const panel = await ask(user, 'open the inbox');
    await user.click(await within(panel).findByRole('button', { name: 'Open Inbox' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/\/inbox$/));
    expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument();
  });

  it('start: a ready workflow is a prepared start (nothing starts); one that is not ready says why', async () => {
    const api = new FakeXo();
    api.studio.askAnswer = {
      kind: 'start',
      summary: '“Send each client their document” is ready. Open it to see what it will do, then start it.',
      workflow: { workflowId: 'wfl_1', name: 'Send each client their document' },
      ready: true,
    };
    const user = await home(api);
    const panel = await ask(user, 'send the documents');
    expect(await within(panel).findByRole('button', { name: 'Open to start' })).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method === 'POST' && /\/runs$/.test(c.path))).toHaveLength(0);

    api.studio.askAnswer = {
      kind: 'start',
      summary: '“Send each client their document” cannot start yet.',
      workflow: { workflowId: 'wfl_1', name: 'Send each client their document' },
      ready: false,
      why: 'It has not passed the check before starting yet. Open it and run that check first.',
    };
    await user.type(screen.getByLabelText('Ask XO'), 'again{enter}');
    expect(await within(panel).findByText('Not ready to start')).toBeInTheDocument();
    expect(within(panel).getByText(/run that check first/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Open to start' })).not.toBeNull();
    expect(within(panel).getAllByRole('button', { name: 'Open the workflow' })).toHaveLength(1);
  });

  it('analyse: a dropped document is read and shown with what XO found, then offered as a source', async () => {
    const api = new FakeXo();
    api.studio.askAnswer = {
      kind: 'analyse',
      documentId: 'src_1',
      fileName: 'release.md',
      status: 'succeeded',
      compilationId: 'cmp_1',
      summary: 'XO read “release.md”. It found 2 steps to carry out.',
      found: {
        documentKinds: [{ kind: 'procedure', label: 'A procedure', evidence: [{ matched: 'Pull the latest code', where: 'page 1' }] }],
        stepCount: 2,
      },
      canUseAsSource: true,
    };
    const user = await home(api);
    await user.click(await screen.findByLabelText('Ask XO'));
    const panel = await screen.findByRole('dialog', { name: 'Ask XO conversation' });
    const input = panel.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(input, new File(['# Release'], 'release.md', { type: 'text/markdown' }));
    expect(await within(panel).findByText(/It found 2 steps to carry out/)).toBeInTheDocument();
    expect(within(panel).getByText('Pull the latest code')).toBeInTheDocument();
    expect(api.studio.askBodies.at(-1)).toMatchObject({ text: '', context: { documentId: expect.any(String) } });
    await user.click(within(panel).getByRole('button', { name: 'Use it as a source' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/\/sources$/));
  });

  it('every question carries where the person is', async () => {
    const api = new FakeXo();
    const user = await home(api);
    await openScreen(user, 'Setup');
    await ask(user, 'what is in here');
    await waitFor(() => expect(api.studio.askBodies.length).toBeGreaterThan(0));
    expect(api.studio.askBodies[0]).toMatchObject({ context: { place: 'sources' } });
  });

  it('a refusal from the platform keeps the text and says what happened', async () => {
    const api = new FakeXo();
    api.studio.chatReply = { fail: 412, code: 'XO_PRECONDITION_FAILED', message: 'No model is configured.' };
    const user = await home(api);
    await ask(user, 'hello');
    expect(await screen.findByText(/No model is configured/)).toBeInTheDocument();
  });
});
