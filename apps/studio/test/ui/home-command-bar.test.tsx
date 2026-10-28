import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HomeCommandBar } from '../../src/ui/HomeCommandBar';

const chips = [
  { label: 'Add a document', target: 'documents' as const },
  { label: 'Create XO from scratch', target: 'create' as const },
];

function Harness(props: { onSend?: (t: string) => void; onChip?: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <HomeCommandBar
      chips={chips}
      onChip={props.onChip as never}
      dock={{
        open,
        onOpenChange: setOpen,
        focusTick: 0,
        chat: {
          list: { phase: 'ready', threads: [] },
          attachable: [],
          activeId: undefined,
          thread: undefined,
          loadingThread: false,
          sending: false,
          problem: undefined,
          select: () => {},
          startNew: () => {},
          send: async (t) => {
            props.onSend?.(t);
            return true;
          },
          remove: async () => {},
        },
        xos: [],
        onOpenSettings: () => {},
      }}
    />
  );
}

describe('Home command bar', () => {
  it('sends what was typed and clears the bar', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);
    await user.type(screen.getByLabelText('Ask XO'), 'what is waiting for me{enter}');
    expect(onSend).toHaveBeenCalledWith('what is waiting for me');
    expect(screen.getByLabelText('Ask XO')).toHaveValue('');
  });

  it('does not send an empty message', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSend={onSend} />);
    await user.type(screen.getByLabelText('Ask XO'), '   {enter}');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it('quick actions go where their label says', async () => {
    const onChip = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChip={onChip} />);
    await user.click(screen.getByRole('button', { name: 'Create XO from scratch' }));
    expect(onChip).toHaveBeenCalledWith('create');
  });

  it('the Ask mode control is shown as unavailable, not as a working control', () => {
    render(<Harness />);
    expect(screen.getByText('Ask ▾')).toHaveAttribute('aria-disabled', 'true');
  });

  it('opens the full-screen chat as soon as the bar is focused, and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Ask XO'));
    expect(screen.getByRole('dialog', { name: 'Ask XO conversation' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ask XO conversation' })).not.toBeInTheDocument());
  });
});
