import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatComposer, ChatLog } from '../../src/ui/ChatScreen';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

const xos = [
  { id: 'burglary-policy', label: 'burglary-policy' },
  { id: 'my-claims-rules', label: 'my-claims-rules' },
];

describe('ChatLog and ChatComposer', () => {
  it('shows saved messages as a polite live log and names the model that answered', () => {
    render(
      <ChatLog
        thread={{
          threadId: 't1',
          title: 'Hello',
          updatedAt: '2026-10-28T10:00:00Z',
          messageCount: 2,
          messages: [
            { messageId: 'm1', role: 'user', content: 'hello', at: '2026-10-28T10:00:00Z', attachedXos: ['burglary-policy'] },
            {
              messageId: 'm2',
              role: 'assistant',
              content: 'Hi there.',
              at: '2026-10-28T10:00:01Z',
              model: { provider: 'anthropic', model: 'test-model' },
            },
          ],
        }}
      />,
    );
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(within(log).getByText('hello')).toBeInTheDocument();
    expect(within(log).getByText('@burglary-policy')).toBeInTheDocument();
    expect(within(log).getByText('Answered by anthropic · test-model')).toBeInTheDocument();
  });

  it('sends on Enter, keeps Shift+Enter for a new line, ignores empty messages, and clears only after a successful send', async () => {
    const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const user = userEvent.setup();
    render(<ChatComposer xos={xos} onSend={onSend} />);
    const box = screen.getByLabelText('Message');
    await user.type(box, '{enter}');
    expect(onSend).not.toHaveBeenCalled();
    await user.type(box, 'line one{Shift>}{enter}{/Shift}line two{enter}');
    expect(onSend).toHaveBeenCalledWith('line one\nline two', []);
    expect(box).toHaveValue('line one\nline two'); // the platform did not save it: the text stays so it can be resent
    await user.keyboard('{enter}');
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('attaches an installed XO by typing @, shows it as a removable chip, and sends it with the message', async () => {
    const onSend = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<ChatComposer xos={xos} onSend={onSend} />);
    await user.type(screen.getByLabelText('Message'), 'check this @bur');
    await user.click(within(screen.getByRole('listbox', { name: 'XOs you can attach' })).getByRole('button', { name: '@burglary-policy' }));
    expect(screen.getByRole('button', { name: 'Remove burglary-policy' })).toBeInTheDocument();
    await user.keyboard('{enter}');
    expect(onSend).toHaveBeenCalledWith('check this', ['burglary-policy']);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove burglary-policy' })).not.toBeInTheDocument());
  });

  it('controls that do nothing are announced as unavailable', () => {
    render(<ChatComposer xos={xos} onSend={async () => true} />);
    for (const name of ['Attach', 'Ask ▾', 'Runtime ▾'])
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
  });
});

async function home(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Claims Ops' });
  return user;
}
const posts = (api: FakeXo, re: RegExp) => api.calls.filter((c) => c.method === 'POST' && re.test(c.path));

describe('Ask XO is backed by the platform', () => {
  it('creates a saved thread on the first message, shows the model that answered, and keeps the conversation after closing', async () => {
    const api = new FakeXo();
    const user = await home(api);
    await user.type(await screen.findByLabelText('Ask XO'), 'what is an XO{enter}');
    const panel = await screen.findByRole('dialog', { name: 'Ask XO conversation' });
    const log = within(panel).getByRole('log', { name: 'Messages' });
    expect(await within(log).findByText('Here is an answer.')).toBeInTheDocument();
    expect(within(log).getByText('Answered by anthropic · test-model')).toBeInTheDocument();
    expect(posts(api, /\/chats$/)).toHaveLength(1);
    expect(posts(api, /\/messages$/)).toHaveLength(1);
    expect(within(panel).getByText('Today')).toBeInTheDocument();
    expect(within(panel).getAllByText(/private to you/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Preview')).not.toBeInTheDocument();
    expect(window.location.hash).not.toBe('#/chat');
  });

  it('a second message reuses the thread; New chat starts another; a saved thread can be reopened and deleted after confirming', async () => {
    const api = new FakeXo();
    const user = await home(api);
    const bar = await screen.findByLabelText('Ask XO');
    await user.type(bar, 'first{enter}');
    const panel = await screen.findByRole('dialog', { name: 'Ask XO conversation' });
    await within(panel).findByText('Here is an answer.');
    await user.type(screen.getByLabelText('Ask XO'), 'second{enter}');
    await waitFor(() => expect(posts(api, /\/messages$/)).toHaveLength(2));
    expect(posts(api, /\/chats$/)).toHaveLength(1);
    const side = within(panel).getByRole('navigation', { name: 'Conversations' });
    await user.click(within(side).getByRole('button', { name: /new chat/i }));
    await user.type(screen.getByLabelText('Ask XO'), 'other topic{enter}');
    await waitFor(() => expect(posts(api, /\/chats$/)).toHaveLength(2));
    await waitFor(() =>
      expect(
        within(side)
          .getAllByRole('button')
          .filter((b) => b.classList.contains('askdock-thread')),
      ).toHaveLength(2),
    );
    const first = within(side).getByRole('button', { name: 'first' });
    await user.click(first);
    expect(await within(panel).findByText('second')).toBeInTheDocument();
    await user.click(within(side).getByRole('button', { name: 'Delete first' }));
    expect(api.studio.chats).toHaveLength(2); // one click deletes nothing
    await user.click(within(side).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.studio.chats).toHaveLength(1));
  });

  it('attaches an installed XO by name and sends it to the platform', async () => {
    const api = new FakeXo();
    api.studio.installs.push({ name: 'burglary-policy', version: '1.0.0' });
    const user = await home(api);
    await user.click(await screen.findByLabelText('Ask XO'));
    await user.type(screen.getByLabelText('Ask XO'), 'review @bur');
    await user.click(await screen.findByRole('button', { name: '@burglary-policy' }));
    await user.type(screen.getByLabelText('Ask XO'), 'it{enter}');
    await waitFor(() => expect(posts(api, /\/messages$/)).toHaveLength(1));
    expect((posts(api, /\/messages$/)[0]!.body as { attach: string[] }).attach).toEqual(['burglary-policy']);
  });

  it('when no model is available (412), shows the platform message, points to Settings → Models and runtime, and keeps the text', async () => {
    const api = new FakeXo();
    api.studio.chatReply = { fail: 412, code: 'XO_PRECONDITION_FAILED', message: 'no model is selected for this workspace' };
    const user = await home(api);
    await user.type(await screen.findByLabelText('Ask XO'), 'hello{enter}');
    const panel = await screen.findByRole('dialog', { name: 'Ask XO conversation' });
    expect(await within(panel).findByText(/no model is selected for this workspace/)).toBeInTheDocument();
    expect(screen.getByLabelText('Ask XO')).toHaveValue('hello'); // not saved, so the text is still there to resend
    await user.click(within(panel).getByRole('button', { name: /Settings → Models and runtime/ }));
    expect(await screen.findByRole('tab', { name: 'Models and runtime', selected: true })).toBeInTheDocument();
  });

  it('on a provider failure (502) says nothing was saved', async () => {
    const api = new FakeXo();
    api.studio.chatReply = { fail: 502, code: 'XO_UPSTREAM', message: 'the model provider failed' };
    const user = await home(api);
    await user.type(await screen.findByLabelText('Ask XO'), 'hello{enter}');
    const panel = await screen.findByRole('dialog', { name: 'Ask XO conversation' });
    expect(await within(panel).findByText(/Nothing was saved/)).toBeInTheDocument();
    expect(within(panel).queryByText('Hello')).not.toBeInTheDocument();
  });

  it('the full Chat screen lists the same saved threads and says they are private', async () => {
    const api = new FakeXo();
    const user = await home(api);
    await user.type(await screen.findByLabelText('Ask XO'), 'hello{enter}');
    await screen.findByText('Here is an answer.');
    await user.keyboard('{Escape}');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'full chat{Enter}');
    await waitFor(() => expect(window.location.hash).toBe('#/chat'));
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    expect(await within(nav).findByRole('button', { name: 'hello' })).toBeInTheDocument();
    expect(screen.getAllByText(/private to you|visible only to you/).length).toBeGreaterThan(0);
  });

  it('Ctrl+J, Escape and the palette still reach the bar from other pages', async () => {
    const api = new FakeXo();
    const user = await home(api);
    await user.click(screen.getByRole('button', { name: 'Library' }));
    await user.keyboard('{Control>}j{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Ask XO conversation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Ask XO')).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument());
  });
});
