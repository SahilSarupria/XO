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

  it('Home opens the Ask XO drawer with the first message and a fixed reply, without leaving Home', async () => {
    const user = await home();
    await user.type(await screen.findByLabelText('Ask XO'), 'what do i have{enter}');
    const drawer = await screen.findByRole('dialog', { name: /ask xo|what do i have/i });
    const log = within(drawer).getByRole('log', { name: 'Messages' });
    expect(within(log).getByText('what do i have')).toBeInTheDocument();
    expect(await within(log).findByText(/This workspace holds/)).toBeInTheDocument();
    expect(within(drawer).getByText('Preview')).toBeInTheDocument();
    expect(window.location.hash).not.toBe('#/chat'); // still on Home
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
  });

  it('the drawer grows into the full Chat screen with the same conversation, and the rail leads back', async () => {
    const user = await home();
    await user.type(await screen.findByLabelText('Ask XO'), 'hello{enter}');
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Open full chat' }));
    await waitFor(() => expect(window.location.hash).toBe('#/chat'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(await screen.findByRole('log', { name: 'Messages' })).getByText('hello')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ New chat' }));
    expect(screen.getByRole('heading', { name: 'New chat' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Workflows' }));
    expect(await screen.findByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
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

  it('a bar at the top of every page except Home opens the drawer on the same page, with the cursor in the message box', async () => {
    const user = await app();
    for (const name of ['Library', 'Activity', 'Audit log']) {
      await user.click(screen.getByRole('button', { name }));
      const bar = screen.getByRole('button', { name: 'Ask XO' });
      await user.click(bar);
      const drawer = await screen.findByRole('dialog', { name: 'Ask XO' });
      expect(within(drawer).getByLabelText('Message')).toHaveFocus();
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-current', 'page');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(bar).toHaveFocus(); // focus returns to where it was
    }
  });

  it('Ctrl+J opens and closes it, and a message asked there stays in the conversation on the page you are on', async () => {
    const user = await app();
    await user.click(screen.getByRole('button', { name: 'Library' }));
    await user.keyboard('{Control>}j{/Control}');
    const drawer = await screen.findByRole('dialog', { name: 'Ask XO' });
    await user.type(within(drawer).getByLabelText('Message'), 'show me the graph{enter}');
    expect(await within(drawer).findByText(/steps in the order XO composed them/)).toBeInTheDocument();
    expect(window.location.hash).toBe('#/library');
    await user.keyboard('{Control>}j{/Control}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('is reachable from the palette too', async () => {
    const user = await app();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox', { name: 'Type a command' }), 'ask{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Ask XO' })).toBeInTheDocument();
  });
});
