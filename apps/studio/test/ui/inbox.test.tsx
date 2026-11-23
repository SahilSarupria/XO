import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen, findStart } from './nav';

async function waitingDecision(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
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
  await user.click(await findStart(user));
  await screen.findByRole('region', { name: 'Inbox' });
  return user;
}

describe('Inbox', () => {
  it('says so, and invents nothing, when nothing is waiting', async () => {
    const api = new FakeXo();
    const user = userEvent.setup();
    render(withShell(<App fetchImpl={api.fetch} />));
    await user.type(screen.getByLabelText(/access key/i), api.validKey);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
    await user.click(screen.getByRole('button', { name: /create workspace/i }));
    await screen.findByRole('heading', { name: 'Ops' });
    await openScreen(user, 'Tasks');
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });
});
