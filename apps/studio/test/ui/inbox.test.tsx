import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

async function waitingDecision(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: /connect/i }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await user.click(screen.getByRole('button', { name: /^sources/i }));
  await user.upload(
    document.getElementById('file-upload') as HTMLInputElement,
    new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
  );
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await openScreen(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /start this process/i }));
  await screen.findByRole('heading', { name: 'Inbox' });
  return user;
}

describe('Inbox', () => {
  it('lists what is waiting on the left and shows the chosen item on the right, with Approve / Reject', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    await waitingDecision(api);
    const list = await screen.findByRole('list', { name: /waiting for a person/i });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByText(/needs review 1/i)).toBeInTheDocument();
    // Visible words follow the design; accessible names are unchanged.
    const approve = screen.getByRole('button', { name: 'Approve this step' });
    expect(approve).toHaveTextContent(/^Approve$/);
    expect(screen.getByRole('button', { name: 'Reject and stop' })).toHaveTextContent(/^Reject$/);
  });

  it('records the decision through the platform and keeps the outcome visible', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const user = await waitingDecision(api);
    await user.click(await screen.findByRole('button', { name: 'Approve this step' }));
    expect(await screen.findByText('Decision recorded.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'POST' && c.path.endsWith('/resume'))).toBe(true);
  });

  it('says so, and invents nothing, when nothing is waiting', async () => {
    const api = new FakeXo();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: /connect/i }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops' });
    await openScreen(user, 'Tasks');
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });
});
