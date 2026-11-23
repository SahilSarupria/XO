/**
 * UW-12b (ADR 0052) — the control screens in Studio: why XO did this (evidence), a live inbox, handing a step to someone else,
 * asking for changes, choosing between item sources, what a run produced and what can be learned from it, and a preview that never
 * approves. Studio decides nothing: each refusal is the platform's, and what a person is told is put in words from codes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { approvalWords, decidedByWords, effectStateWords, keptWords, manifestWords, matchWords } from '../../src/domain/evidence';
import type { RunEvidence } from '../../src/platform/wire-control';
import { App } from '../../src/ui/App';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { findStart, openScreen, openWorkflow, workspaceReady } from './nav';

async function signedIn(api: FakeXo) {
  window.history.replaceState(null, '', '#/home');
  const user = userEvent.setup();
  render(withShell(<App fetchImpl={api.fetch} />));
  await user.type(screen.getByLabelText(/access key/i), api.validKey);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.type(await screen.findByLabelText(/workspace name/i), 'Ops');
  await user.click(screen.getByRole('button', { name: /create workspace/i }));
  await workspaceReady('Ops');
  return user;
}
async function inbox(api: FakeXo) {
  const user = await signedIn(api);
  await openScreen(user, 'Tasks');
  await screen.findByRole('region', { name: 'Inbox' });
  return user;
}
const DEF = `gwf_${'0'.repeat(23)}1`;
const pendingRun = (n: number) => ({
  runId: `run_${n}`,
  state: 'waiting',
  pendingApprovals: [{ approvalId: `apr_${n}`, step: 's1', summary: `Check certificate ${n}`, expiresAt: '2030-01-01T00:00:00.000Z' }],
  decisions: [],
});
const openStep = async (user: Awaited<ReturnType<typeof signedIn>>, n: number) => {
  const list = await screen.findByRole('list', { name: /waiting for a person/i });
  await user.click(within(list).getByText(`Check certificate ${n}`));
  return screen.findByLabelText('Step waiting for a person');
};
const batch = (createdBy = 'ana') => ({
  previewId: `pvw_${'0'.repeat(23)}1`,
  definitionId: DEF,
  certificateId: `wrc_${'0'.repeat(23)}1`,
  root: 'sha256:rrrrrrrr1',
  createdBy,
});
const css = () =>
  ['src/styles/inbox.css', 'apps/studio/src/styles/inbox.css']
    .map((p) => {
      try {
        return readFileSync(resolve(process.cwd(), p), 'utf8');
      } catch {
        return '';
      }
    })
    .join('');

describe('UW-12b control screens', () => {
  it('evidence is put in words: where it came from, who decided, what was sent', async () => {
    expect(matchWords('exact')).toBe('matched exactly');
    expect(matchWords('loose')).toBe('matched loosely, so a person should check it');
    expect(matchWords('by_name')).toBe('matched by another rule (by_name)');
    expect(decidedByWords({ step: 's', type: 'approval', decidedBy: 'person', by: 'rita', outcome: '' })).toBe('decided by rita');
    expect(decidedByWords({ step: 's', type: 'approval', decidedBy: 'standing_approval', outcome: '' })).toBe(
      'covered by a standing approval',
    );
    expect(effectStateWords('outcome_unknown')).toBe('outcome unknown, needs a check');
    expect(effectStateWords('brand_new')).toBe('brand_new');
    const e = {
      approval: { kind: 'batch', reviewerId: 'rita', selfApproved: true },
      manifest: { digestOk: false },
    } as unknown as RunEvidence;
    expect(approvalWords(e)).toBe('Approved in a batch by rita (who also prepared it).');
    expect(manifestWords(e)).toMatch(/does not match its certificate/);
    expect(keptWords('')).toBe('No retention is recorded');

    // On screen, from the platform's record: no recipient, no cell value, no document content.
    const api = new FakeXo();
    api.generatedRuns.push(pendingRun(1));
    const user = await inbox(api);
    const step = await openStep(user, 1);
    await user.click(within(step).getByRole('button', { name: 'Why XO is asking' }));
    const view = await screen.findByLabelText('Why XO did this');
    expect(within(view).getByLabelText('Where it came from')).toHaveTextContent(
      "From each client's certificate, row 3 of Renewals, with the document cert-3.pdf (matched exactly).",
    );
    expect(within(view).getByText('Approved in a batch by rita.')).toBeInTheDocument();
    expect(within(view).getByText('check_certificate: covered by the batch approval (approved)')).toBeInTheDocument();
    expect(within(view).getByText('mail send_certificate (irreversible): done')).toBeInTheDocument();
    expect(within(view).getByText('This run used exactly the workflow that was certified.')).toBeInTheDocument();
  });

  it('the inbox refreshes by itself when the platform says it changed, and stops asking when it is closed', async () => {
    const api = new FakeXo();
    api.previews.push(batch());
    const user = await inbox(api);
    const rows = async () =>
      within(await screen.findByRole('list', { name: /waiting for a person/i })).getAllByText('Send certificates: 3 items');
    expect(await rows()).toHaveLength(1);
    await waitFor(() => expect(api.inboxChangeCalls).toBeGreaterThan(0));
    // Another person prepares a second batch; the waiting request ends and the list reloads without a click.
    api.previews.push({ ...batch('bob'), previewId: `pvw_${'0'.repeat(23)}2`, root: 'sha256:rrrrrrrr2' });
    api.bumpInbox();
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    // S1-3: the watch belongs to the workspace, not the Inbox screen: after leaving the Inbox the sidebar's count still follows
    // the platform, from the same single loop.
    const inboxCount = () =>
      Number(
        /(\d+) need attention/.exec(
          within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('button', { name: /^Inbox/ }).textContent ?? '',
        )?.[1] ?? 0,
      );
    await user.click(within(screen.getByRole('navigation', { name: 'Workspace sections' })).getByRole('button', { name: /^Activity/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Inbox' })).toBeNull());
    const before = inboxCount();
    api.previews.push({ ...batch('bob'), previewId: `pvw_${'0'.repeat(23)}3`, root: 'sha256:rrrrrrrr3' });
    api.bumpInbox();
    await waitFor(() => expect(inboxCount()).toBe(before + 1));
  });

  it('handing a step over needs a reviewer and a reason; a step handed to someone else cannot be decided by you', async () => {
    const api = new FakeXo();
    api.generatedRuns.push(pendingRun(1), pendingRun(2));
    api.assignments['apr_2'] = 'meera-identity';
    const user = await inbox(api);
    const step = await openStep(user, 1);
    await user.click(within(step).getByRole('button', { name: 'Hand to someone else' }));
    const form = within(await screen.findByRole('group', { name: 'Hand to someone else' }));
    const hand = form.getByRole('button', { name: 'Hand over' });
    expect(hand).toBeDisabled();
    await user.selectOptions(await form.findByRole('combobox'), 'meera-identity');
    expect(hand).toBeDisabled(); // a reason as well
    await user.type(form.getByLabelText('Why?'), 'she knows the client');
    await user.click(hand);
    await waitFor(() => expect(api.delegations).toEqual([{ approvalId: 'apr_1', to: 'meera-identity', reason: 'she knows the client' }]));
    expect((await screen.findAllByText('Handed over. Only they can decide this step now.')).length).toBeGreaterThan(0);

    // A step already handed to someone else says so and offers no decision.
    const other = await openStep(user, 2);
    expect(within(other).getByText('This step was handed to meera-identity. Only they can decide it.')).toBeInTheDocument();
    expect(within(other).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(other).getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(api.generatedRuns[1]!.state).toBe('waiting');
  });

  it('asking for changes needs a comment; the batch then says so and cannot be approved', async () => {
    const api = new FakeXo();
    api.previews.push(batch());
    const user = await inbox(api);
    const card = await screen.findByLabelText('Batch to approve');
    await user.click(await within(card).findByRole('button', { name: 'Request changes' }));
    const form = within(within(card).getByRole('group', { name: 'Request changes' }));
    expect(form.getByRole('button', { name: 'Send request' })).toBeDisabled();
    await user.type(form.getByLabelText('What needs to change?'), 'leave out the two who paid late');
    await user.click(form.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(api.changesAsked[batch().previewId]?.comment).toBe('leave out the two who paid late'));
    expect(
      (await screen.findAllByText('Changes requested. The batch cannot be approved until it is prepared again.')).length,
    ).toBeGreaterThan(0);
    // After the reload the batch carries the request, in words, and approving is not offered.
    expect(await screen.findByText(/Changes were requested by sally: leave out the two who paid late/)).toBeInTheDocument();
    expect(api.previews[0]!.approval).toBeUndefined();
  });

  it('with more than one usable source it asks which and prepares nothing until one is chosen', async () => {
    const src = (over: Record<string, unknown> = {}) => ({
      connectionId: `scn_${'1'.repeat(24)}`,
      proposalId: `rol_${'2'.repeat(16)}`,
      role: 'per_person_documents',
      label: "each client's certificate",
      connectionName: 'Renewals',
      digests: [],
      changedSinceConfirmation: false,
      fields: ['email'],
      items: 3,
      excluded: 0,
      missingFields: [],
      usable: true,
      ...over,
    });
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    api.requireCertificate = true;
    api.irOnly = true;
    api.runApprovalRequired = true;
    api.itemSources = {
      forEach: true,
      fieldsUsed: ['email'],
      sources: [src(), src({ proposalId: `rol_${'3'.repeat(16)}`, label: 'a client list', connectionName: 'Office' })],
    };
    const user = await signedIn(api);
    await user.click(screen.getByRole('button', { name: /^sources/i }));
    await user.upload(
      document.getElementById('file-upload') as HTMLInputElement,
      new File(['%PDF'], 'procedure.pdf', { type: 'application/pdf' }),
    );
    await user.click(await screen.findByRole('button', { name: /^analyse$/i }));
    await screen.findByText(/settlement amount must be recorded/i);
    await openScreen(user, 'Work');
    await user.click(await findStart(user));
    const picker = await screen.findByRole('group', { name: 'Which list should it use' });
    expect(api.previews).toHaveLength(0);
    await user.click(within(picker).getByRole('button', { name: 'Use a client list in Office' }));
    await waitFor(() => expect(api.previews).toHaveLength(1));
    expect(api.previews[0]!.items).toEqual({ connectionId: `scn_${'1'.repeat(24)}`, proposalId: `rol_${'3'.repeat(16)}` });
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Which list should it use' })).toBeNull());
  });

  const withCertifiedPanel = async (api: FakeXo) => {
    api.certificateStatus = 'READY';
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
    await panel().findByRole('button', { name: 'Check again' });
    await user.click(panel().getByRole('button', { name: 'Show runs on the workflow runtime' }));
    return { user, panel };
  };

  it('outputs say who can open each thing and how long it is kept', async () => {
    const api = new FakeXo();
    api.outputs = [
      {
        kind: 'delivery',
        item: 0,
        name: 'Certificate email',
        type: 'email',
        state: 'confirmed',
        access: 'the recipient and the workspace owner',
        kept: 'for 30 days',
      },
      { kind: 'document', name: 'cert-3.pdf', type: 'pdf', access: 'reviewers of this workspace', kept: '' },
    ];
    api.generatedRuns.push({ runId: 'run_1', state: 'completed', pendingApprovals: [], decisions: [] });
    const { user, panel } = await withCertifiedPanel(api);
    await user.click(await panel().findByRole('button', { name: 'Show results' }));
    const out = await screen.findByLabelText('What it produced');
    expect(
      within(out).getByText(
        /Certificate email \(item 1\): email, confirmed\. Who can open it: the recipient and the workspace owner\. Kept for 30 days\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(out).getByText(/cert-3\.pdf: pdf\. Who can open it: reviewers of this workspace\. No retention is recorded\./),
    ).toBeInTheDocument();
  });

  it('observations can be proposed as knowledge, and a correction needs a field, a value and a reason', async () => {
    const api = new FakeXo();
    api.observations = [
      {
        observationId: `obs_${'a'.repeat(16)}`,
        kind: 'correction',
        item: 1,
        at: '2026-11-20T10:00:00.000Z',
        summary: 'A reviewer changed the address on item 2.',
      },
      {
        observationId: `obs_${'b'.repeat(16)}`,
        kind: 'exclusion',
        at: '2026-11-20T10:00:00.000Z',
        summary: 'A row was left out: no document found.',
      },
    ];
    api.generatedRuns.push({ runId: 'run_1', state: 'completed', pendingApprovals: [], decisions: [] });
    const { user, panel } = await withCertifiedPanel(api);
    await user.click(await panel().findByRole('button', { name: 'Show results' }));
    const learn = await screen.findByLabelText('What XO noticed');
    const propose = within(learn).getByRole('button', { name: 'Propose as knowledge' });
    expect(propose).toBeDisabled();
    await user.click(await within(learn).findByRole('checkbox', { name: /A reviewer changed the address on item 2/ }));
    await user.click(propose);
    await waitFor(() => expect(api.learningProposals).toEqual([[`obs_${'a'.repeat(16)}`]]));
    expect(
      await within(learn).findByText(/Proposed\. A reviewer approves it in What XO knows; until then XO knows nothing new\./),
    ).toBeInTheDocument();

    await user.click(within(learn).getByRole('button', { name: 'Correct a value' }));
    const form = within(within(learn).getByRole('group', { name: 'Correct a value' }));
    const record = form.getByRole('button', { name: 'Record the correction' });
    await user.type(form.getByLabelText('Which field'), 'email');
    await user.type(form.getByLabelText('What it should have been'), 'new@example.org');
    expect(record).toBeDisabled(); // a reason as well
    await user.type(form.getByLabelText('Why'), 'the client moved');
    await user.click(record);
    await waitFor(() => expect(api.corrections).toEqual([{ field: 'email', value: 'new@example.org', reason: 'the client moved' }]));
  });

  it('"Preview what it would do" prepares a preview and never approves or starts anything', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
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
    await user.click(await screen.findByRole('button', { name: 'Preview what it would do' }));
    expect(await screen.findByText(/Nothing was sent, started or approved\. The preview covers 3 items/)).toBeInTheDocument();
    expect(api.previews).toHaveLength(1);
    expect(api.previews[0]!.approval).toBeUndefined();
    expect(api.generatedRuns).toHaveLength(0);
    expect(api.calls.some((c) => c.method === 'POST' && /\/(approve|runs)$/.test(c.path) && /generated-workflows/.test(c.path))).toBe(
      false,
    );
  });

  it('the new controls meet the phone tap-target rule', () => {
    const media = css().slice(css().lastIndexOf('/* UW-12b (ADR 0052)'));
    expect(media).toContain('@media (max-width: 44rem)');
    expect(media).toContain('min-height: 2.75rem');
    expect(media).toContain('.rr .btn');
    expect(media).toContain('.es .btn');
  });
});
