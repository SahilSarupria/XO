import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { setDetailLevel } from './nav';

type U = ReturnType<typeof userEvent.setup>;
const nav = () => screen.getByRole('navigation', { name: /workspace sections/i });

async function contracts(api: FakeXo): Promise<{ user: U; card: HTMLElement }> {
  api.publishContract = true;
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops', level: 1 });
  await user.click(within(nav()).getByRole('button', { name: /^my xos/i }));
  await user.upload(document.getElementById('file-upload') as HTMLInputElement, new File(['%PDF'], 'p.pdf', { type: 'application/pdf' }));
  await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
  await screen.findByText(/settlement amount must be recorded/i);
  await setDetailLevel(user, 'builder');
  await user.click(within(nav()).getByRole('button', { name: /^contracts/i }));
  const list = await screen.findByRole('list', { name: 'Capability contracts' });
  const card = within(list).getByRole('heading', { name: 'Record before payment' }).closest('li') as HTMLElement;
  await user.click(within(card).getByText('Preview and Test Run', { selector: 'summary' }));
  return { user, card };
}
const posts = (api: FakeXo, re: RegExp) => api.calls.filter((c) => c.method === 'POST' && re.test(c.path));

describe('Capability Preview and Test Run', () => {
  it('previews without executing, shows the platform result, and keeps Test Run off while unapproved', async () => {
    const api = new FakeXo();
    const { user, card } = await contracts(api);
    expect(within(card).getByRole('button', { name: 'Test Run' })).toBeDisabled();
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    const result = await within(card).findByRole('region', { name: 'Preview result' });
    expect(within(result).getByText('Preview only')).toBeInTheDocument();
    expect(within(result).getByText(/does not prove the real run will succeed/)).toBeInTheDocument();
    expect(within(result).getByRole('list', { name: 'Blockers' })).toHaveTextContent(/not approved/);
    expect(within(result).getByRole('list', { name: 'Plan' })).toBeInTheDocument();
    expect(within(result).getByText('None')).toBeInTheDocument(); // external effects
    expect(within(card).getByRole('button', { name: 'Test Run' })).toBeDisabled();
    expect(posts(api, /\/executions$/)).toHaveLength(0);
  });

  it('after approval and a passing preview, Test Run is a real recorded execution', async () => {
    const api = new FakeXo();
    const { user, card } = await contracts(api);
    await user.click(within(card).getByRole('button', { name: 'Approve this rule' }));
    await waitFor(() => expect(api.approvals.size).toBe(1));
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    await within(card).findByRole('region', { name: 'Preview result' });
    const run = within(card).getByRole('button', { name: 'Test Run' });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    expect(await within(card).findByRole('region', { name: 'Test Run result' })).toHaveTextContent(
      /real run through the same approval gate/,
    );
    expect(posts(api, /\/executions$/)).toHaveLength(1);
  });

  it('a changed input needs a new preview before Test Run is enabled again', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    const { user, card } = await contracts(api);
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    await within(card).findByRole('region', { name: 'Preview result' });
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Test Run' })).toBeEnabled());
    await user.type(within(card).getByLabelText(/Sample input/), ' ');
    expect(within(card).getByRole('button', { name: 'Test Run' })).toBeDisabled();
    expect(within(card).getByText(/Preview again to enable a Test Run/)).toBeInTheDocument();
  });

  it('rejects input that is not a JSON object before asking the platform', async () => {
    const api = new FakeXo();
    const { user, card } = await contracts(api);
    const box = within(card).getByLabelText(/Sample input/);
    await user.clear(box);
    await user.click(box);
    await user.paste('[1]');
    expect(within(card).getByRole('alert')).toHaveTextContent(/JSON object/);
    expect(within(card).getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(posts(api, /\/preview$/)).toHaveLength(0);
  });

  it('hints for a viewer, and still shows the platform refusal when the role hint was stale', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    const { card } = await contracts(api);
    expect(within(card).getByRole('button', { name: 'Preview' })).toBeDisabled();
    expect(within(card).getAllByText(/access does not include/).length).toBeGreaterThan(0);
  });

  it('shows the refusal from the platform when it refuses a preview the UI allowed', async () => {
    const api = new FakeXo();
    api.studio.role = 'viewer';
    api.studio.reportedRole = 'admin';
    const { user, card } = await contracts(api);
    await user.click(within(card).getByRole('button', { name: 'Preview' }));
    expect(await within(card).findByRole('alert')).toBeInTheDocument();
    expect(within(card).queryByRole('region', { name: 'Preview result' })).not.toBeInTheDocument();
  });
});
