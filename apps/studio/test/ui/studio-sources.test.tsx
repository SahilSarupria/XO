import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

async function openCreate(api: FakeXo) {
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  await openScreen(user, 'Setup');
  await user.click(screen.getByRole('button', { name: 'XOs' }));
  await user.click(screen.getByRole('button', { name: '+ Create XO' }));
  return user;
}
const calls = (api: FakeXo, path: RegExp) => api.calls.filter((c) => c.method === 'POST' && path.test(c.path));
beforeEach(() => window.localStorage.clear());

describe('add a source by link or pasted text', () => {
  it('imports an https link through the platform', async () => {
    const api = new FakeXo();
    const user = await openCreate(api);
    await user.type(screen.getByLabelText('Link to a document'), 'https://example.com/policy.txt');
    await user.click(screen.getByRole('button', { name: 'Import link' }));
    await waitFor(() => expect(calls(api, /\/sources\/import$/)).toHaveLength(1));
    expect((calls(api, /\/sources\/import$/)[0]!.body as { url: string }).url).toBe('https://example.com/policy.txt');
  });

  it('does not send a non-https link', async () => {
    const api = new FakeXo();
    const user = await openCreate(api);
    await user.type(screen.getByLabelText('Link to a document'), 'http://example.com/a');
    await user.click(screen.getByRole('button', { name: 'Import link' }));
    expect(await screen.findByText('Links must start with https://.')).toBeInTheDocument();
    expect(calls(api, /\/sources\/import$/)).toHaveLength(0);
  });

  it('shows the platform refusal when the workspace is air-gapped', async () => {
    const api = new FakeXo();
    api.studio.settings.airGapped = true;
    const user = await openCreate(api);
    await user.type(screen.getByLabelText('Link to a document'), 'https://example.com/a');
    await user.click(screen.getByRole('button', { name: 'Import link' }));
    expect(await screen.findByText(/air-gapped/i)).toBeInTheDocument();
  });

  it('uploads pasted text as a .txt document', async () => {
    const api = new FakeXo();
    const user = await openCreate(api);
    await user.click(screen.getByRole('button', { name: 'Paste text' }));
    await user.type(screen.getByLabelText('Name'), 'Refund rules');
    await user.type(screen.getByLabelText('Text'), 'Refunds within 30 days.');
    await user.click(screen.getByRole('button', { name: 'Add text' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST' && /\/sources$/.test(c.path))).toBe(true));
  });

  it('disables the controls for a viewer, as a hint only', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const user = await openCreate(api);
    expect(screen.getByLabelText('Link to a document')).toBeDisabled();
    expect(screen.getByText(/access does not include adding documents/)).toBeInTheDocument();
    void user;
  });
});
