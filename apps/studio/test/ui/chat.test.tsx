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
    expect(within(log).getByText('anthropic · test-model')).toBeInTheDocument();
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
    for (const name of ['Attach', 'Auto ▾', 'Runtime ▾'])
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
    expect(within(log).getByText('anthropic · test-model')).toBeInTheDocument();
    expect(posts(api, /\/intelligence\/conversations$/)).toHaveLength(1);
    expect(posts(api, /\/turns$/)).toHaveLength(1);
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
    await waitFor(() => expect(posts(api, /\/turns$/)).toHaveLength(2));
    expect(posts(api, /\/intelligence\/conversations$/)).toHaveLength(1);
    const side = within(panel).getByRole('navigation', { name: 'Conversations' });
    await user.click(within(side).getByRole('button', { name: /new chat/i }));
    await user.type(screen.getByLabelText('Ask XO'), 'other topic{enter}');
    await waitFor(() => expect(posts(api, /\/intelligence\/conversations$/)).toHaveLength(2));
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
    await waitFor(() => expect(posts(api, /\/turns$/)).toHaveLength(1));
    expect((posts(api, /\/turns$/)[0]!.body as { attach: string[] }).attach).toEqual(['burglary-policy']);
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

describe('answers show how XO understood the message and what it rests on', () => {
  it('shows the route, confidence, sources and a way to rate an answer; a rating is sent to the platform', async () => {
    const api = new FakeXo();
    const user = await home(api);
    await user.type(await screen.findByLabelText('Ask XO'), 'does burglary cover need forced entry?{enter}');
    const panel = await screen.findByRole('dialog', { name: 'Ask XO conversation' });
    const log = within(panel).getByRole('log', { name: 'Messages' });
    expect(await within(log).findByText('Ask')).toBeInTheDocument();
    expect(within(log).getByText('High confidence')).toBeInTheDocument();
    // Sources are collapsed to a one-line summary until opened, so the answer is what you read first.
    expect(within(log).getByText('1 source')).toBeInTheDocument();
    await user.click(within(log).getByText('1 source'));
    const sources = within(log).getByRole('list', { name: 'Sources' });
    expect(within(sources).getByText('burglary_policy')).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Not helpful' }));
    expect(await within(log).findByText(/recorded for review/)).toBeInTheDocument();
    expect(api.studio.ratings).toEqual([{ messageId: expect.any(String), rating: 'unhelpful' }]);
  });

  it('says plainly when an answer is not backed by sources, and shows a proposed action as not run', async () => {
    const api = new FakeXo();
    api.studio.chatResult = {
      route: 'do',
      confidence: 'none',
      grounded: false,
      citations: [],
      notices: [{ code: 'action_needs_input', message: 'Missing or unusable input: assignee.' }],
      proposal: { capabilityName: 'Create task', inputs: { title: 'Chase broker' } },
      usage: { calls: [] },
    };
    const user = await home(api);
    await user.type(await screen.findByLabelText('Ask XO'), 'create a task to chase the broker{enter}');
    const log = within(await screen.findByRole('dialog', { name: 'Ask XO conversation' })).getByRole('log', { name: 'Messages' });
    const proposal = await within(log).findByRole('group', { name: 'Proposed action' });
    expect(within(proposal).getByText(/not run/)).toBeInTheDocument();
    expect(within(log).getByText(/Missing or unusable input: assignee/)).toBeInTheDocument();
    expect(within(log).queryByText(/source/)).not.toBeInTheDocument();
  });
});

describe('reading an answer', () => {
  const result = (over: Record<string, unknown> = {}) => ({
    route: 'ask' as const,
    confidence: 'medium' as const,
    grounded: true,
    citations: [
      { index: 1, sourceName: 'Aastha.pdf', asOf: '2026-11-08T00:00:00Z', excerpt: 'Capability "Generate MIS reports" … Found on page 2.' },
      { index: 2, sourceName: 'Aastha.pdf', excerpt: 'Capability "Map CRM records" … Found on page 1.' },
    ],
    notices: [] as { code: string; message: string }[],
    followUps: [] as string[],
    ...over,
  });
  const thread = (content: string, r: ReturnType<typeof result>) => ({
    threadId: 't',
    title: 'T',
    updatedAt: '2026-11-08T10:00:00Z',
    messageCount: 2,
    messages: [
      { messageId: 'u', role: 'user' as const, content: 'q', at: '2026-11-08T10:00:00Z' },
      {
        messageId: 'a',
        role: 'assistant' as const,
        content,
        at: '2026-11-08T10:00:01Z',
        result: r,
        model: { provider: 'gemini', model: 'gemini-x' },
      },
    ],
  });

  it('turns model text into paragraphs and bullet lists instead of one run-on paragraph', () => {
    render(<ChatLog thread={thread('You can automate:\n- Reports [1]\n- Mapping [2]\n\nAsk me more.', result())} />);
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(
      within(log)
        .getAllByRole('listitem')
        .filter((li) => /Reports|Mapping/.test(li.textContent ?? '')),
    ).toHaveLength(2);
    expect(within(log).getByText('You can automate:')).toBeInTheDocument();
    expect(within(log).getByText('Ask me more.')).toBeInTheDocument();
  });

  it('shows markup in a reply as plain text, never as HTML', () => {
    render(<ChatLog thread={thread('<img src=x onerror=alert(1)> and **bold**', result())} />);
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(log.querySelector('img')).toBeNull();
    expect(within(log).getByText('bold').tagName).toBe('STRONG');
    expect(log.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a citation marker opens the sources and the sources are collapsed until then', async () => {
    const user = userEvent.setup();
    render(<ChatLog thread={thread('Reports are possible [1].', result())} />);
    const log = screen.getByRole('log', { name: 'Messages' });
    const details = log.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(log).getByText('2 sources')).toBeInTheDocument();
    await user.click(within(log).getByRole('button', { name: 'Source 1' }));
    await waitFor(() => expect(details.open).toBe(true));
    expect(within(log).getByRole('list', { name: 'Sources' })).toBeInTheDocument();
  });

  it('does not repeat a notice that says the same thing as the reply, and does not label a non-claim as unbacked', () => {
    const msg = "I couldn't find anything about that.";
    render(
      <ChatLog
        thread={thread(
          msg,
          result({ grounded: false, confidence: 'none', citations: [], notices: [{ code: 'no_sources_found', message: msg }] }),
        )}
      />,
    );
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(within(log).getAllByText(msg)).toHaveLength(1);
    expect(within(log).queryByText(/Not backed/)).not.toBeInTheDocument();
  });

  it('flags a confident-looking answer that cites nothing', () => {
    render(<ChatLog thread={thread('Probably yes.', result({ grounded: false, confidence: 'low', citations: [] }))} />);
    expect(screen.getByText(/Not backed by any source/)).toBeInTheDocument();
  });

  it('offers follow-up questions on the latest answer only, and sends the one you pick', async () => {
    const user = userEvent.setup();
    const onFollowUp = vi.fn();
    render(<ChatLog thread={thread('Done.', result({ followUps: ['Which can run today?'] }))} onFollowUp={onFollowUp} />);
    await user.click(screen.getByRole('button', { name: 'Which can run today?' }));
    expect(onFollowUp).toHaveBeenCalledWith('Which can run today?');
  });

  it('says which provider and model wrote the answer', () => {
    render(<ChatLog thread={thread('Done.', result())} />);
    expect(screen.getByText('gemini · gemini-x')).toBeInTheDocument();
  });
});
