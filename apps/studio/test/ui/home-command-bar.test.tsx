import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HomeCommandBar } from '../../src/ui/HomeCommandBar';

const chips = [
  { label: 'Add a document', target: 'documents' as const },
  { label: 'Create XO from scratch', target: 'create' as const },
];

describe('Home command bar', () => {
  it('opens the conversation with what was typed, and clears the bar', async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(<HomeCommandBar onAsk={onAsk} chips={chips} />);
    await user.type(screen.getByLabelText('Ask XO'), 'what is waiting for me{enter}');
    expect(onAsk).toHaveBeenCalledWith('what is waiting for me');
    expect(screen.getByLabelText('Ask XO')).toHaveValue('');
  });

  it('does not send an empty message, and is labelled a preview', async () => {
    const onAsk = vi.fn();
    const user = userEvent.setup();
    render(<HomeCommandBar onAsk={onAsk} chips={chips} />);
    await user.type(screen.getByLabelText('Ask XO'), '   {enter}');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onAsk).not.toHaveBeenCalled();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('quick actions go where their label says', async () => {
    const onChip = vi.fn();
    const user = userEvent.setup();
    render(<HomeCommandBar onAsk={() => {}} chips={chips} onChip={onChip} />);
    await user.click(screen.getByRole('button', { name: 'Create XO from scratch' }));
    expect(onChip).toHaveBeenCalledWith('create');
  });

  it('the Ask mode control is shown as unavailable, not as a working control', () => {
    render(<HomeCommandBar onAsk={() => {}} chips={chips} />);
    expect(screen.getByText('Ask ▾')).toHaveAttribute('aria-disabled', 'true');
  });
});
