import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { openScreen } from './nav';

type U = ReturnType<typeof userEvent.setup>;

async function analysed(api: FakeXo): Promise<U> {
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
  return user;
}

async function openGraph(user: U) {
  await openScreen(user, 'Work');
  await user.click(await screen.findByRole('button', { name: /view graph of/i }));
  return screen.findByRole('region', { name: 'Workflow graph' });
}

const puts = (api: FakeXo) => api.calls.filter((c) => c.method === 'PUT' && /workflow-definitions\//.test(c.path));
const runCalls = (api: FakeXo) => api.calls.filter((c) => /workflow-definitions\/[^/]+\/run/.test(c.path));

describe('Workflow drafts', () => {
  it('validates live with the platform, shows its errors and the reasons Run is unavailable, and never calls run', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    const draft = screen.getByRole('region', { name: 'Draft' });
    expect(await within(draft).findByRole('list', { name: 'Reasons this draft cannot run' })).toHaveTextContent(
      /no executor for user-authored/,
    );
    expect(within(draft).getByRole('button', { name: 'Execute draft' })).toBeDisabled();
    await user.click(within(draft).getByRole('button', { name: 'Execute draft' }));
    expect(runCalls(api)).toHaveLength(0);
    expect(api.calls.some((c) => /workflow-definitions\/validate$/.test(c.path))).toBe(true);
  });

  it('saves a new draft, then saves again with the revision it loaded', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved as revision 1/)).toBeInTheDocument();
    expect(api.studio.drafts).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeInTheDocument();
    expect((puts(api)[0]!.body as { expectedRevision: number }).expectedRevision).toBe(1);
  });

  it('on a stale revision reloads the newer draft and says nothing was overwritten', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    api.studio.drafts[0]!.revision = 5;
    api.studio.drafts[0]!.name = 'Changed by a colleague';
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/nothing was overwritten/)).toBeInTheDocument();
    expect(screen.getByLabelText('Draft name')).toHaveValue('Changed by a colleague');
    expect(screen.getByText(/revision 5/, { selector: 'p' })).toBeInTheDocument();
    expect(api.studio.drafts[0]!.name).toBe('Changed by a colleague');
  });

  it('opens and deletes a saved draft after confirming', async () => {
    const api = new FakeXo();
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved as revision 1/);
    const list = await screen.findByRole('list', { name: 'Saved drafts' });
    await user.click(within(list).getByRole('button', { name: /^Delete / }));
    expect(api.studio.drafts).toHaveLength(1);
    await user.click(within(list).getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.studio.drafts).toHaveLength(0));
  });

  it('shows the platform refusal when a stale role hint lets a viewer try to save', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'admin';
    const user = await analysed(api);
    await openGraph(user);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(screen.getByRole('region', { name: 'Draft' })).findByRole('alert')).toBeInTheDocument();
    expect(api.studio.drafts).toHaveLength(0);
  });

  it('disables Save as a hint for a viewer whose role is known', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const user = await analysed(api);
    await openGraph(user);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByText(/access does not include saving workflows/)).toBeInTheDocument();
  });
});
