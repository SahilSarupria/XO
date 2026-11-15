/**
 * PX-8 (gap PX-G26) — Studio shows the platform's pre-start certificate apart from the mode readiness: its status, every
 * gate with what it found, and whether it is still current. Studio decides nothing itself.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, openWorkflow } from './nav';

async function openedWorkflow(api: FakeXo) {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await user.click(screen.getByRole('button', { name: /^my xos/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await openScreen(user, 'Work');
  await waitFor(() => expect(document.querySelector('[data-wf-open]')).not.toBeNull());
  await openWorkflow(user);
  return { user, panel: () => within(screen.getByRole('region', { name: 'Pre-start check' })) };
}

describe('the pre-start check', () => {
  it('asks the platform only when asked, then shows the status and what each gate found', async () => {
    const api = new FakeXo();
    const { user, panel } = await openedWorkflow(api);
    expect(api.certifyCalls).toBe(0);
    await user.click(panel().getByRole('button', { name: 'Check before starting' }));
    expect(await panel().findByText('Needs a person first')).toBeInTheDocument();
    expect(panel().getByText(/not approved for its current contract/)).toBeInTheDocument();
    expect(panel().getByText('Every step is approved').closest('li')).toHaveAttribute('data-outcome', 'review');
    expect(panel().getByText('The documents could be read').closest('li')).toHaveAttribute('data-outcome', 'pass');
  });

  it('shows READY, and says when a certificate is no longer current', async () => {
    const api = new FakeXo();
    api.certificateStatus = 'READY';
    const { user, panel } = await openedWorkflow(api);
    await user.click(panel().getByRole('button', { name: 'Check before starting' }));
    expect(await panel().findByText('Ready to start')).toBeInTheDocument();
    await user.click(panel().getByRole('button', { name: 'Check it is still current' }));
    expect(await panel().findByRole('status')).toHaveTextContent('Still current: a start can present it.');
    api.certificateCurrent = false;
    await user.click(panel().getByRole('button', { name: 'Check it is still current' }));
    await waitFor(() =>
      expect(panel().getByRole('status')).toHaveTextContent(/no longer allows a start: stale: the knowledge state changed/i),
    );
  });

  it('a blocked workflow lists its blocker', async () => {
    const api = new FakeXo();
    api.certificateStatus = 'BLOCKED';
    const { user, panel } = await openedWorkflow(api);
    await user.click(panel().getByRole('button', { name: 'Check before starting' }));
    expect(await panel().findByText('Blocked')).toBeInTheDocument();
    expect(panel().getByText(/"Pay out" bound: not bound/)).toBeInTheDocument();
  });
});
