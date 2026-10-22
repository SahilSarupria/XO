import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatThread } from '../../src/domain/chat';
import { ChatScreen } from '../../src/ui/ChatScreen';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';

const xos = [
  { id: 'c1', label: 'burglary-policy', sourceId: 's1', at: '2026-10-01T00:00:00Z' },
  { id: 'c2', label: 'my-claims-rules', sourceId: 's2', at: '2026-10-02T00:00:00Z' },
];
const thread: ChatThread = {
  id: 't1',
  title: 'Compile burglary-policy',
  messages: [
    { id: 1, from: 'you', text: 'hello' },
    { id: 2, from: 'xo', text: 'Ask for something.', action: { label: 'Open Tasks', target: 'tasks' } },
  ],
};

function Harness(props: { onSend?: (t: string, a: readonly string[]) => void; goTo?: (t: string) => void; threads?: ChatThread[] }) {
  const [id, setId] = useState<string | undefined>(props.threads?.[0]?.id);
  return (
    <ChatScreen
      threads={props.threads ?? []}
      activeId={id}
      onSelect={setId}
      onNew={() => setId(undefined)}
      onSend={props.onSend ?? (() => {})}
      xos={xos}
      goTo={(props.goTo ?? (() => {})) as never}
    />
  );
}

describe('Chat screen', () => {
  it('shows the conversation as a polite live log, with replies marked as preview replies', () => {
    render(<Harness threads={[thread]} />);
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(within(log).getByText('hello')).toBeInTheDocument();
    expect(within(log).getByText(/XO preview reply/)).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByText('session memory')).toBeInTheDocument();
  });

  it('lists only real conversations and real XOs, and is honest that there is no trace', () => {
    render(<Harness />);
    expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
    const ctx = screen.getByRole('complementary', { name: 'Context' });
    expect(within(ctx).getByText('burglary-policy')).toBeInTheDocument();
    expect(within(ctx).getByText(/Not available yet/)).toBeInTheDocument();
    expect(screen.queryByText(/extract|build-xoir|session 1\./i)).not.toBeInTheDocument();
  });

  it('sends on Enter, keeps Shift+Enter for a new line, and ignores empty messages', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);
    const box = screen.getByLabelText('Message');
    await user.type(box, '{enter}');
    expect(onSend).not.toHaveBeenCalled();
    await user.type(box, 'line one{Shift>}{enter}{/Shift}line two{enter}');
    expect(onSend).toHaveBeenCalledWith('line one\nline two', []);
    expect(box).toHaveValue('');
  });

  it('attaches an XO by typing @, shows it as a removable chip, and sends it with the message', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);
    await user.type(screen.getByLabelText('Message'), 'check this @bur');
    await user.click(within(screen.getByRole('listbox', { name: 'XOs you can attach' })).getByRole('button', { name: '@burglary-policy' }));
    expect(screen.getByRole('button', { name: 'Remove burglary-policy' })).toBeInTheDocument();
    await user.keyboard('{enter}');
    expect(onSend).toHaveBeenCalledWith('check this', ['burglary-policy']);
    expect(screen.queryByRole('button', { name: 'Remove burglary-policy' })).not.toBeInTheDocument();
  });

  it('a reply action goes to the screen it names', async () => {
    const goTo = vi.fn();
    const user = userEvent.setup();
    render(<Harness threads={[thread]} goTo={goTo} />);
    await user.click(screen.getByRole('button', { name: 'Open Tasks →' }));
    expect(goTo).toHaveBeenCalledWith('tasks');
  });

  it('controls that do nothing yet are announced as unavailable, not left looking live', () => {
    render(<Harness />);
    for (const name of ['Attach', 'Ask ▾', 'Runtime ▾']) expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Chat inside the app', () => {
  async function home() {
    const api = new FakeXo();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Claims Ops' });
    return user;
  }

  it('Home: typing unfolds the conversation from the bar, and Enter gets a fixed preview reply without leaving Home', async () => {
    const user = await home();
    const bar = await screen.findByLabelText('Ask XO');
    await user.type(bar, 'w');
    expect(await screen.findByRole('dialog', { name: 'Ask XO conversation' })).toBeInTheDocument(); // opened by typing, before any send
    await user.type(bar, 'hat do i have{enter}');
    const panel = screen.getByRole('dialog', { name: 'Ask XO conversation' });
    const log = within(panel).getByRole('log', { name: 'Messages' });
    expect(within(log).getByText('what do i have')).toBeInTheDocument();
    expect(await within(log).findByText(/This workspace holds/)).toBeInTheDocument();
    expect(screen.getAllByText('Preview').length).toBeGreaterThan(0);
    expect(window.location.hash).not.toBe('#/chat');
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });

  it('focusing the bar opens the full-screen chat straight away; Close chat returns to the same page with the conversation kept for the Chat screen', async () => {
    const user = await home();
    await user.click(await screen.findByLabelText('Ask XO')); // focus alone is enough
    expect(await screen.findByRole('dialog', { name: 'Ask XO conversation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open full chat' })).not.toBeInTheDocument(); // it is already the full chat
    await user.type(screen.getByLabelText('Ask XO'), 'hello{enter}');
    const panel = screen.getByRole('dialog', { name: 'Ask XO conversation' });
    expect(await within(panel).findByRole('log', { name: 'Messages' })).toHaveTextContent('hello');
    await user.click(within(panel).getByRole('button', { name: /close chat/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument());
    expect(window.location.hash).not.toBe('#/chat');
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'full chat{Enter}');
    await waitFor(() => expect(window.location.hash).toBe('#/chat'));
    expect(within(await screen.findByRole('log', { name: 'Messages' })).getByText('hello')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ New chat' }));
    expect(screen.getByRole('heading', { name: 'New chat' })).toBeInTheDocument();
  });
});

describe('Ask XO chat layout', () => {
  async function opened() {
    const api = new FakeXo();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Claims Ops' });
    await user.click(screen.getByLabelText('Ask XO'));
    return { user, panel: await screen.findByRole('dialog', { name: 'Ask XO conversation' }) };
  }

  it('looks like a chat app: conversations sidebar, a welcome with starters, the bar at the bottom, and a preview note', async () => {
    const { panel } = await opened();
    const side = within(panel).getByRole('navigation', { name: 'Conversations' });
    expect(within(side).getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    expect(within(side).getByText('No conversations yet.')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'What can XO help with?' })).toBeInTheDocument();
    expect(within(panel).getByText(/replies here are fixed examples/i)).toBeInTheDocument();
  });

  it('a starter sends a fixed preview reply; conversations list in the sidebar and can be switched between', async () => {
    const { user, panel } = await opened();
    await user.click(within(panel).getByRole('button', { name: 'What do I have in this workspace?' }));
    expect(await within(panel).findByText(/This workspace holds/)).toBeInTheDocument();
    const side = within(panel).getByRole('navigation', { name: 'Conversations' });
    await user.click(within(side).getByRole('button', { name: /new chat/i }));
    expect(within(panel).getByRole('heading', { name: 'What can XO help with?' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Ask XO'), 'show me the graph{enter}');
    expect(await within(panel).findByText(/steps in the order XO composed them/)).toBeInTheDocument();
    const items = within(side).getAllByRole('button').filter((b) => b.classList.contains('askdock-thread'));
    expect(items).toHaveLength(2);
    await user.click(items[1]!);
    expect(await within(panel).findByText(/This workspace holds/)).toBeInTheDocument();
    expect(items[1]).toHaveAttribute('aria-current', 'true');
  });
});

describe('Ask XO from every screen', () => {
  async function app() {
    const api = new FakeXo();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Claims Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Claims Ops' });
    return user;
  }

  it('every page except Home has the same bar at the top; typing unfolds the conversation on that page', async () => {
    const user = await app();
    for (const name of ['Library', 'Activity', 'Audit log']) {
      await user.click(screen.getByRole('button', { name }));
      const bar = screen.getByLabelText('Ask XO');
      expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument();
      await user.type(bar, 'x');
      expect(await screen.findByRole('dialog', { name: 'Ask XO conversation' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument());
      expect(bar).toHaveFocus(); // the cursor stays in the bar
      await user.clear(bar);
    }
  });

  it('Ctrl+J puts the cursor in the bar and shows the conversation, and a message asked there stays on the page you are on', async () => {
    const user = await app();
    await user.click(screen.getByRole('button', { name: 'Library' }));
    await user.keyboard('{Control>}j{/Control}');
    const panel = await screen.findByRole('dialog', { name: 'Ask XO conversation' });
    expect(screen.getByLabelText('Ask XO')).toHaveFocus();
    await user.type(screen.getByLabelText('Ask XO'), 'show me the graph{enter}');
    expect(await within(panel).findByText(/steps in the order XO composed them/)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/library');
    await user.keyboard('{Control>}j{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument());
  });

  it('is reachable from the palette too', async () => {
    const user = await app();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'ask{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Ask XO conversation' })).toBeInTheDocument();
  });
});
