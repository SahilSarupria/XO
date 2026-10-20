import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { HomeCommandBar } from '../../src/ui/HomeCommandBar';

function Harness(props: { goTo: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  return <HomeCommandBar open={open} onOpenChange={setOpen} goTo={props.goTo as never} />;
}

describe('Home command bar', () => {
  it('expands into a conversation on focus and answers with a real destination', async () => {
    const goTo = vi.fn();
    const user = userEvent.setup();
    render(<Harness goTo={goTo} />);
    expect(screen.queryByRole('region', { name: /conversation/i })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Ask XO'));
    expect(screen.getByRole('region', { name: /conversation/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Ask XO'), 'what is waiting for me{enter}');
    expect(screen.getByText(/collected in Tasks/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Tasks' }));
    expect(goTo).toHaveBeenCalledWith('tasks');
  });

  it('Escape closes the conversation, and the bar is labelled a preview', async () => {
    const user = userEvent.setup();
    render(<Harness goTo={() => {}} />);
    await user.click(screen.getByLabelText('Ask XO'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: /conversation/i })).not.toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });
});
