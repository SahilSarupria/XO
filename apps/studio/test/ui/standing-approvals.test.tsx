/**
 * UW-16c (ADR 0051) — standing approvals in Studio: asking for one, deciding it in the Inbox, seeing why a run needs approval, and
 * revoking. Studio decides nothing: the digest on screen is sent back, and every refusal (separation of duties, a person who signed in)
 * is the platform's, shown in plain words.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { boundsLines, reasonWords, reasonsSentence } from '../../src/domain/standing';
import { parseControlInbox, parseStanding } from '../../src/platform/wire-control';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { chooseFromMenu, openScreen, openWorkflow } from './nav';

async function signedIn(api: FakeXo) {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await screen.findByRole('heading', { name: 'Ops' });
  return user;
}

const DEF = `gwf_${'0'.repeat(23)}1`;
const CERT = `wrc_${'0'.repeat(23)}1`;
const source = () => ({
  connectionId: `scn_${'1'.repeat(24)}`,
  proposalId: `rol_${'2'.repeat(16)}`,
  role: 'per_person_documents',
  label: "each client's certificate",
  connectionName: 'Renewals',
  digests: [],
  changedSinceConfirmation: false,
  fields: ['client_name', 'email'],
  items: 3,
  excluded: 1,
  missingFields: [],
  usable: true,
});
const seed = (api: FakeXo, over: { proposedBy?: string; status?: 'proposed' | 'active' } = {}) => {
  const id = `sap_${String(api.standingApprovals.length + 1).padStart(24, '0')}`;
  api.previews.push({
    previewId: `pvw_${'9'.repeat(24)}`,
    definitionId: DEF,
    certificateId: CERT,
    root: 'sha256:sample',
    createdBy: 'sally',
    standingSample: true,
  });
  api.standingApprovals.push({
    id,
    status: over.status ?? 'proposed',
    proposedBy: over.proposedBy ?? 'sally',
    ...(over.status === 'active' ? { approvedBy: 'amir' } : {}),
    body: {
      definitionId: DEF,
      certificateId: CERT,
      samplePreviewId: `pvw_${'9'.repeat(24)}`,
      limits: { maxItemsPerRun: 3, maxItemsPerPeriod: 6, maxRunsPerPeriod: 2, period: 'week' },
      triggers: ['manual', 'schedule'],
      note: 'monthly certificates',
    },
  });
  return id;
};
const openInbox = async (user: Awaited<ReturnType<typeof signedIn>>) => {
  await openScreen(user, 'Tasks');
  await screen.findByRole('region', { name: 'Inbox' });
};

describe('standing approvals', () => {
  it('UW-16c: proposing sends the bounds, pins every value by default and shows the platform refusal when every value of an irreversible step may vary', async () => {
    const api = new FakeXo();
    api.certificateStatus = 'READY';
    api.itemSources = { forEach: true, over: 'client_items', fieldsUsed: ['client_name'], sources: [source()] };
    const user = await signedIn(api);
    await user.click(screen.getByRole('button', { name: /^sources/i }));
    await user.upload(
      document.getElementById('file-upload') as HTMLInputElement,
      new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
    );
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    await screen.findByText(/settlement amount must be recorded/i);
    await openScreen(user, 'Work');
    await waitFor(() => expect(document.querySelector('[data-wf-open]')).not.toBeNull());
    await openWorkflow(user);
    const panel = () => within(screen.getByRole('region', { name: 'Pre-start check' }));
    await user.click(panel().getByRole('button', { name: 'Check before starting' }));
    const form = await screen.findByRole('region', { name: 'Let this run without asking each time' });
    await user.click(within(form).getByRole('button', { name: 'Set this up' }));
    const ask = within(form).getByRole('button', { name: 'Ask for approval' });
    expect(ask).toBeDisabled(); // nothing is chosen by default
    await user.click(await within(form).findByRole('radio', { name: /each client's certificate/ }));
    await user.selectOptions(within(form).getByLabelText('Per'), 'month');
    await user.click(ask);
    await within(form).findByText(/Waiting for someone else to approve/);
    expect(api.proposals).toHaveLength(1);
    expect(api.proposals[0]).toMatchObject({
      definitionId: DEF,
      items: { connectionId: source().connectionId, proposalId: source().proposalId },
      limits: { maxItemsPerRun: 3, maxItemsPerPeriod: 3, maxRunsPerPeriod: 1, period: 'month', maxExcludedRows: 0 },
      mayVary: [],
      triggers: ['manual'],
      expiresInDays: 30,
    });
    // Everything is fixed to the sample unless the person says otherwise; the platform refuses to let all of an irreversible step vary.
    api.refuseAllVary = true;
    for (const box of within(form).getAllByRole('checkbox', { name: /may change/ })) await user.click(box);
    await user.click(within(form).getByRole('button', { name: 'Ask again with these changes' }));
    expect(await within(form).findByText(/at least one of its values must stay fixed/)).toBeInTheDocument();
  });

  it('UW-16c: the inbox approves a standing approval with the policy digest on screen and shows the separation refusal in words', async () => {
    const api = new FakeXo();
    api.separation = true;
    seed(api);
    const user = await signedIn(api);
    await openInbox(user);
    const card = await screen.findByLabelText('Standing approval to decide');
    expect(within(card).getByText(/At most 3 items in one run/)).toBeInTheDocument();
    expect(within(card).getByText(/"to" must be one of the 2 values in the sample/)).toBeInTheDocument();
    expect(within(card).getByText(/You asked for this/)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await user.click(within(card).getByRole('button', { name: 'Yes, approve' }));
    expect(
      await within(card).findByText(/Someone other than the person who asked, or the person it runs as, must approve this/),
    ).toBeInTheDocument();
    expect(api.standingApprovals[0]!.status).toBe('proposed');
    api.separation = false;
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await user.click(within(card).getByRole('button', { name: 'Yes, approve' }));
    expect(await screen.findByText(/Approved\. It is recorded as your signed decision/)).toBeInTheDocument();
    expect(api.standingApprovals[0]!.status).toBe('active');
  });

  it('UW-16c: asking for changes needs a comment', async () => {
    const api = new FakeXo();
    seed(api);
    const user = await signedIn(api);
    await openInbox(user);
    const card = await screen.findByLabelText('Standing approval to decide');
    await user.click(within(card).getByRole('button', { name: 'Ask for changes' }));
    const send = within(card).getByRole('button', { name: 'Send back' });
    expect(send).toBeDisabled();
    await user.type(within(card).getByLabelText('What should change?'), 'fewer recipients per run');
    await user.click(send);
    expect(await screen.findByText(/Sent back with your comment/)).toBeInTheDocument();
    expect(api.standingApprovals[0]).toMatchObject({ status: 'changes_requested', comment: 'fewer recipients per run' });
  });

  it('UW-16c: revoking needs a reason and a confirmation, and the list shows it revoked', async () => {
    const api = new FakeXo();
    const id = seed(api, { status: 'active' });
    const user = await signedIn(api);
    await chooseFromMenu(user, 'Settings');
    await user.click(await screen.findByRole('tab', { name: 'Standing approvals' }));
    const item = (await screen.findByText(id)).closest('li') as HTMLElement;
    expect(within(item).getByText(/This week: 1 of 2 runs, 2 of 6 items/)).toBeInTheDocument();
    expect(within(item).getByText(/Approved by amir/)).toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Revoke' }));
    expect(within(item).getByRole('button', { name: 'Revoke' })).toBeDisabled(); // a reason first
    await user.type(within(item).getByLabelText('Why?'), 'wrong list');
    await user.click(within(item).getByRole('button', { name: 'Revoke' }));
    expect(api.standingApprovals[0]!.status).toBe('active'); // not yet: it asks
    await user.click(within(item).getByRole('button', { name: 'Yes, revoke it' }));
    await waitFor(() => expect(api.standingApprovals[0]).toMatchObject({ status: 'revoked', revokedReason: 'wrong list' }));
    expect(await screen.findByText(/Revoked .*wrong list/)).toBeInTheDocument();
  });

  it('UW-16c: a fallback batch says why it needs approval, in words', async () => {
    const api = new FakeXo();
    api.previews.push({
      previewId: `pvw_${'0'.repeat(23)}1`,
      definitionId: DEF,
      certificateId: CERT,
      root: 'sha256:rrrrrrrr1',
      createdBy: 'sally',
    });
    api.fallbackReasons[`pvw_${'0'.repeat(23)}1`] = ['value_not_approved', 'period_runs', 'something_new'];
    const user = await signedIn(api);
    await openInbox(user);
    const note = await screen.findByLabelText('Why this needs your approval');
    expect(note).toHaveTextContent(
      'This run needs your approval because: a value is not one that was approved (for example a new recipient); it would run more often than allowed this day; another reason (something_new).',
    );
  });

  it('UW-16c: an approved, unused batch can be revoked from the inbox', async () => {
    const api = new FakeXo();
    api.previews.push({
      previewId: `pvw_${'0'.repeat(23)}1`,
      definitionId: DEF,
      certificateId: CERT,
      root: 'sha256:rrrrrrrr1',
      createdBy: 'amir',
      approval: {
        approvalId: `bap_${'1'.repeat(24)}`,
        reviewerId: 'sally',
        approvedAt: '2026-11-20T11:00:00.000Z',
        expiresAt: '2030-01-01T00:00:00.000Z',
      },
    });
    const user = await signedIn(api);
    await openInbox(user);
    await user.click(await screen.findByRole('button', { name: 'Revoke approval' }));
    const group = screen.getByRole('group', { name: 'Revoke approval' });
    expect(within(group).getByRole('button', { name: 'Revoke it' })).toBeDisabled();
    await user.type(within(group).getByLabelText('Why?'), 'changed my mind');
    await user.click(within(group).getByRole('button', { name: 'Revoke it' }));
    await waitFor(() => expect(api.revokedBatchApprovals).toEqual([{ previewId: `pvw_${'0'.repeat(23)}1`, reason: 'changed my mind' }]));
  });

  it('UW-16c: standing approval controls meet the phone tap-target rule', () => {
    const css = ['src/styles/inbox.css', 'apps/studio/src/styles/inbox.css']
      .map((p) => {
        try {
          return readFileSync(resolve(process.cwd(), p), 'utf8');
        } catch {
          return '';
        }
      })
      .join('');
    const media = css.slice(css.lastIndexOf('/* UW-16c'));
    expect(media).toContain('@media (max-width: 44rem)');
    expect(media).toContain('min-height: 2.75rem');
    expect(media).toContain('.sa-form .btn');
  });

  it('UW-16c: reasons and bounds are put in words, and an unknown reason is shown rather than hidden', () => {
    expect(reasonWords('too_many_items')).toBe('more items than allowed in one run');
    expect(reasonWords('period_items', 'week')).toBe('it would pass the limit for this week');
    expect(reasonWords('revoked')).toBe('the standing approval was revoked');
    expect(reasonWords('brand_new')).toBe('another reason (brand_new)');
    expect(reasonsSentence(['expired', 'not_approved'])).toBe('the standing approval expired; the standing approval is not approved yet');
  });
});

describe('standing approval wire', () => {
  const valid = {
    standingApprovalId: `sap_${'a'.repeat(24)}`,
    status: 'active',
    definitionId: DEF,
    certificateId: CERT,
    policyDigest: 'sha256:abc',
    items: { kind: 'source', connectionId: 'scn_1', proposalId: 'rol_1' },
    effects: [{ connector: 'mail', operation: 'send_certificate', sideEffect: 'irreversible' }],
    pinned: [{ step: 'send', argument: 'to', count: 2 }],
    mayVary: [],
    presignSteps: [],
    limits: { maxItemsPerRun: 5, maxItemsPerPeriod: 20, maxRunsPerPeriod: 3, period: 'day', maxExcludedRows: 0 },
    triggers: ['manual'],
    startsAs: { id: 'sally' },
    notBefore: '2026-11-20T10:00:00.000Z',
    expiresAt: '2030-01-01T00:00:00.000Z',
    sample: { previewId: 'pvw_1', root: 'sha256:r', items: 3 },
    proposedBy: 'sally',
    proposedAt: '2026-11-20T10:00:00.000Z',
  };
  it('UW-16c: standing approval views parse strictly; an unknown status fails with its path', () => {
    expect(parseStanding(valid).limits.period).toBe('day');
    expect(boundsLines(parseStanding(valid))[0]).toBe('At most 5 items in one run.');
    expect(() => parseStanding({ ...valid, status: 'paused' })).toThrow(/standingApproval\.status/);
    expect(() => parseStanding({ ...valid, limits: { ...valid.limits, period: 'year' } })).toThrow(/standingApproval\.limits\.period/);
    expect(() => parseStanding({ ...valid, triggers: ['webhook'] })).toThrow(/standingApproval\.triggers/);
  });
  it('UW-16c: an inbox from a platform without standing approvals still parses, with none', () => {
    const inbox = parseControlInbox({ batches: [], steps: [], attention: [], truncated: false });
    expect(inbox.standing).toEqual({ proposals: [], expiring: [], fallbacks: [] });
    expect(() => parseControlInbox({ standing: { proposals: [{}] }, batches: [], steps: [], attention: [] })).toThrow(
      /inbox\.standing\.proposals\[0\]/,
    );
  });
});
