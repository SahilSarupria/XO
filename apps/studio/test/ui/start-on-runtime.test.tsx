/**
 * ADR 0052 — Studio starts a process on the workflow runtime only: it asks the platform for the workflow's readiness certificate
 * and starts the run under it, in a guarded way (one request per click, one key per intent). The composed runner is gone, so nothing
 * is ever sent to its routes.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { findStart, openScreen } from './nav';

async function analysed(api: FakeXo) {
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
  return user;
}
const runsStarted = (api: FakeXo) => api.calls.filter((c) => c.method === 'POST' && /\/generated-workflows\/[^/]+\/runs$/.test(c.path));
const composedStarts = (api: FakeXo) => api.calls.filter((c) => c.method === 'POST' && /\/workflows\/[^/]+\/executions$/.test(c.path));

describe('starting a process (workflow runtime)', () => {
  it('asks for the readiness certificate, starts one run under it with a request key, and says where it is waiting', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    const user = await analysed(api);
    await user.click(await findStart(user));
    expect(
      await screen.findByText(/started on the workflow runtime\. it is waiting for a person: record the settlement amount/i),
    ).toBeInTheDocument();
    expect(api.certifyCalls).toBe(1);
    expect(runsStarted(api)).toHaveLength(1);
    expect(runsStarted(api)[0]!.headers?.['Idempotency-Key']).toMatch(/\S{8,}/);
    expect((runsStarted(api)[0]!.body as { certificateId?: string }).certificateId).toMatch(/^wrc_/);
    expect(composedStarts(api)).toHaveLength(0);
  });

  it('a double click sends one start', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    const user = await analysed(api);
    const start = await findStart(user);
    await user.dblClick(start);
    await screen.findByText(/started on the workflow runtime/i);
    expect(runsStarted(api)).toHaveLength(1);
  });

  it('a process that is not ready says what stands in the way and sends no run', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'NEEDS_REVIEW';
    const user = await analysed(api);
    await user.click(await findStart(user));
    expect(await screen.findByText(/not ready to start \(needs review\)/i)).toBeInTheDocument();
    expect(runsStarted(api)).toHaveLength(0);
    expect(composedStarts(api)).toHaveLength(0);
  });

  it('work that sends or changes things prepares a preview for a reviewer instead of starting', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    api.runApprovalRequired = true;
    const user = await analysed(api);
    await user.click(await findStart(user));
    expect(await screen.findByText(/nothing was sent yet\. xo prepared a preview/i)).toBeInTheDocument();
    expect(within(document.body).queryByText(/started on the workflow runtime/i)).toBeNull();
  });
});
