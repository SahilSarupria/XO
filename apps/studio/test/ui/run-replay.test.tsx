import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '../../src/platform/wire';
import { RunReplay } from '../../src/ui/RunReplay';
import { XosSection } from '../../src/ui/XosSection';

const run = {
  steps: [
    { stepId: 'a', order: 1, capabilityId: 'c1', capabilityName: 'Check cover', status: 'succeeded' },
    { stepId: 'b', order: 2, capabilityId: 'c2', capabilityName: 'Decide', status: 'failed', errorMessage: 'No match' },
  ],
} as unknown as WorkflowRun;

describe('RunReplay', () => {
  it('steps through a run with the slider and announces each step', async () => {
    render(<RunReplay run={run} />);
    expect(screen.getByText(/Move the slider/)).toBeInTheDocument();
    const slider = screen.getByLabelText('Replay position');
    fireEvent.change(slider, { target: { value: '1' } });
    expect(screen.getByRole('status')).toHaveTextContent('Step 1 of 2: Check cover finished.');
    fireEvent.change(slider, { target: { value: '2' } });
    expect(screen.getByRole('status')).toHaveTextContent('Decide did not complete');
    expect(screen.getByText('No match')).toBeInTheDocument();
    expect(screen.getByText(/not how long it took/i)).toBeInTheDocument();
  });
});

describe('XosSection', () => {
  const base = {
    analyses: [],
    sourceCount: 0,
    summary: undefined,
    next: { step: 'context', headline: 'Add your first document', hint: 'Upload a document.' } as const,
    goTo: () => {},
  };

  it('derives steps from real facts and marks Publish as not available', () => {
    render(<XosSection {...base} />);
    expect(screen.getByText('Add documents')).toBeInTheDocument();
    expect(screen.getByText('Not available yet')).toBeInTheDocument();
    expect(screen.getByText('No analyses yet')).toBeInTheDocument();
  });

  it('sends the person to the real step that is current', async () => {
    let to = '';
    render(<XosSection {...base} goTo={(t) => (to = t)} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Open Sources' }));
    expect(to).toBe('documents');
  });
});
