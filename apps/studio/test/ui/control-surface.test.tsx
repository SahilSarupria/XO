/**
 * UW-12b (ADR 0047) — the control surface for work on the workflow runtime, in the Inbox: a batch preview a reviewer approves by
 * the root they were shown, then starts; a waiting step; a call whose outcome is unknown, which a person reconciles; cancel. Studio
 * decides nothing: every refusal is the platform's, shown in plain words.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App';
import { argLines } from '../../src/ui/ControlCards';
import { withShell } from '../shell';
import { FakeXo } from '../fakeXo';
import { findStart, openScreen, workspaceReady } from './nav';

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
const preview = (createdBy: string) => ({
  previewId: `pvw_${'0'.repeat(23)}1`,
  definitionId: DEF,
  certificateId: `wrc_${'0'.repeat(23)}1`,
  root: 'sha256:rrrrrrrr1',
  createdBy,
});

describe('the control surface', () => {
  it('a start that needs a batch approval prepares the preview instead; nothing is sent', async () => {
    const api = new FakeXo();
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    api.requireCertificate = true;
    api.irOnly = true;
    api.runApprovalRequired = true;
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
    expect(
      await screen.findByText(
        /Nothing was sent yet\. XO prepared a preview of exactly what this would do \(3 items, 1 needing attention\)/,
      ),
    ).toBeInTheDocument();
    expect(api.previews).toHaveLength(1);
    expect(api.generatedRuns).toHaveLength(0);
  });

  const perItemSource = (over: Partial<Record<string, unknown>> = {}) => ({
    connectionId: `scn_${'1'.repeat(24)}`,
    proposalId: `rol_${'2'.repeat(16)}`,
    role: 'per_person_documents',
    label: "each client's certificate",
    connectionName: 'Renewals',
    digests: [],
    changedSinceConfirmation: false,
    fields: ['client_name', 'email', 'document_sha256', 'document_name', 'document_type'],
    items: 3,
    excluded: 1,
    missingFields: [],
    usable: true,
    ...over,
  });
  const startPerItem = async (api: FakeXo): Promise<Awaited<ReturnType<typeof signedIn>>> => {
    api.approvals.all = true;
    api.certificateStatus = 'READY';
    api.requireCertificate = true;
    api.irOnly = true;
    api.runApprovalRequired = true;
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
    return user;
  };

  it('V1-1: a process that runs once per item takes its items from the one confirmed source that gives them', async () => {
    const api = new FakeXo();
    api.itemSources = {
      forEach: true,
      over: 'client_items',
      fieldsUsed: ['document_sha256', 'email'],
      sources: [
        perItemSource(),
        perItemSource({
          proposalId: `rol_${'3'.repeat(16)}`,
          role: 'contact_list',
          label: 'a client list',
          usable: false,
          missingFields: ['document_sha256'],
        }),
      ],
    };
    const user = await startPerItem(api);
    expect(
      await screen.findByText(/from each client's certificate in Renewals; 1 left out\)\. A reviewer approves it in the Inbox/),
    ).toBeInTheDocument();
    expect(api.previews.map((p) => p.items)).toEqual([{ connectionId: `scn_${'1'.repeat(24)}`, proposalId: `rol_${'2'.repeat(16)}` }]);
    // The reviewer sees where the items came from and who was left out, and why.
    await openScreen(user, 'Tasks');
    expect(
      await screen.findByText("Items from each client's certificate in Renewals. 1 row was left out: no document found (1)."),
    ).toBeInTheDocument();
  });

  it('V1-1: with no confirmed source that gives what it needs, it says so and prepares nothing', async () => {
    const none = new FakeXo();
    none.itemSources = {
      forEach: true,
      fieldsUsed: ['document_sha256', 'email'],
      sources: [perItemSource({ role: 'contact_list', label: 'a client list', usable: false, missingFields: ['document_sha256'] })],
    };
    await startPerItem(none);
    expect(
      await screen.findByText(
        /no confirmed source gives what it needs for each one \(document_sha256, email\)\. a client list in Renewals lacks document_sha256\./,
      ),
    ).toBeInTheDocument();
    expect(none.previews).toHaveLength(0);
  });

  it('V1-1: with more than one usable source, it does not pick between them', async () => {
    const two = new FakeXo();
    two.itemSources = {
      forEach: true,
      fieldsUsed: ['email'],
      sources: [perItemSource(), perItemSource({ proposalId: `rol_${'3'.repeat(16)}`, label: 'a client list', connectionName: 'Office' })],
    };
    await startPerItem(two);
    expect(
      await screen.findByText(
        /more than one confirmed source could give its items \(each client's certificate in Renewals; a client list in Office\)/,
      ),
    ).toBeInTheDocument();
    expect(two.previews).toHaveLength(0);
  });

  it('shows the batch (counts, sending account, exceptions first), approves the root shown, and starts it with the approval', async () => {
    const api = new FakeXo();
    api.previews.push(preview('ana'));
    const user = await inbox(api);
    const list = await screen.findByRole('list', { name: /waiting for a person/i });
    expect(within(list).getByText('Send certificates: 3 items')).toBeInTheDocument();
    expect(within(list).getByText(/Prepared by ana · waiting for your approval/)).toBeInTheDocument();
    const card = await screen.findByLabelText('Batch to approve');
    expect(within(card).getByText('3 items: 2 would send, 1 stop for a person.')).toBeInTheDocument();
    expect(within(card).getByText('1 needs a look before you approve. They are listed first.')).toBeInTheDocument();
    expect(within(card).getByText('office@example.org')).toBeInTheDocument();
    // UAC-32: the preview says which tier the email goes out in.
    expect((await within(card).findByText(/Sends through the Gmail API/)).closest('li')).toHaveAttribute('data-tier', 'native_api');

    // Exceptions first: only the item that stops is shown until the person asks for all of them.
    expect(await within(card).findByText('the reviewer must check the address')).toBeInTheDocument();
    expect(within(card).queryByText(/person1@example.org/)).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'All items' }));
    expect(await within(card).findByText('to: person1@example.org')).toBeInTheDocument();
    expect(within(card).getByText(`attachments: cert-1.pdf (content ${'1'.repeat(12)})`)).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'GET' && c.path.endsWith('/previews/' + preview('ana').previewId))).toBe(true);

    await user.click(within(card).getByRole('button', { name: 'Approve this batch' }));
    await user.click(within(card).getByRole('button', { name: 'Yes, approve 3 items' }));
    const approved = api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/approve'));
    expect(approved?.body).toEqual({ root: 'sha256:rrrrrrrr1' });

    await user.click(await within(card).findByRole('button', { name: 'Start the approved batch' }));
    const start = api.calls.find((c) => c.method === 'POST' && /\/generated-workflows\/[^/]+\/runs$/.test(c.path));
    expect(start?.body).toEqual({ certificateId: preview('ana').certificateId, batchApprovalId: `bap_${'0'.repeat(23)}1` });
    expect(await screen.findByText('Started: completed.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Batch to approve')).toBeNull());
  });

  it('UW-16a: the steps a person does for each item are unticked by default, and the approval says so', async () => {
    const api = new FakeXo();
    api.previews.push(preview('ana'));
    const user = await inbox(api);
    const card = await screen.findByLabelText('Batch to approve');
    const group = await within(card).findByRole('group', { name: 'Steps a person does for each item' });
    const box = within(group).getByRole('checkbox', { name: /Check the certificate before it goes \(3 items\)/ });
    expect(box).not.toBeChecked();
    await user.click(within(card).getByRole('button', { name: 'Approve this batch' }));
    expect(within(card).getByText(/Each step a person does is still asked in every item\./)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Yes, approve 3 items' }));
    expect(api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/approve'))?.body).toEqual({ root: 'sha256:rrrrrrrr1' });
  });

  it('UW-16a: a ticked step is named in the approval, and the confirmation repeats it', async () => {
    const api = new FakeXo();
    api.previews.push(preview('ana'));
    const user = await inbox(api);
    const card = await screen.findByLabelText('Batch to approve');
    await user.click(await within(card).findByRole('checkbox', { name: /Check the certificate before it goes/ }));
    await user.click(within(card).getByRole('button', { name: 'Approve this batch' }));
    expect(within(card).getByText(/You also decide, for every item: Check the certificate before it goes\./)).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Yes, approve 3 items' }));
    expect(api.calls.find((c) => c.method === 'POST' && c.path.endsWith('/approve'))?.body).toEqual({
      root: 'sha256:rrrrrrrr1',
      presignSteps: ['check_certificate'],
    });
  });

  it('says plainly when the person who prepared the batch cannot approve it (the platform refuses)', async () => {
    const api = new FakeXo();
    api.previews.push(preview('sally'));
    api.separation = true;
    const user = await inbox(api);
    expect(await screen.findByText(/Prepared by you · waiting for a reviewer/)).toBeInTheDocument();
    const card = await screen.findByLabelText('Batch to approve');
    expect(within(card).getByText(/You prepared this batch/)).toBeInTheDocument();
    await user.click(await within(card).findByRole('button', { name: 'Approve this batch' }));
    await user.click(within(card).getByRole('button', { name: 'Yes, approve 3 items' }));
    expect(await within(card).findByText('XO did not accept this batch approval')).toBeInTheDocument();
    expect(
      within(card).getByText(/Someone other than the person who prepared this batch must approve it\. Nothing was sent\./),
    ).toBeInTheDocument();
    expect(within(card).getByText('Ask another reviewer to approve it.')).toBeInTheDocument();
    expect(api.previews[0]!.approval).toBeUndefined();
  });

  it('decides a waiting step on the workflow runtime, and cancels another run after a confirmation', async () => {
    const api = new FakeXo();
    const pending = (n: number) => ({
      runId: `run_${n}`,
      state: 'waiting',
      pendingApprovals: [{ approvalId: `apr_${n}`, step: 's1', summary: `Check certificate ${n}`, expiresAt: '2030-01-01T00:00:00.000Z' }],
      decisions: [],
    });
    api.generatedRuns.push(pending(1), pending(2));
    const user = await inbox(api);
    const list = await screen.findByRole('list', { name: /waiting for a person/i });
    await user.click(within(list).getByText('Check certificate 1'));
    const step = await screen.findByLabelText('Step waiting for a person');
    await user.click(within(step).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Done as instructed. The run is now completed.')).toBeInTheDocument();
    expect(api.generatedRuns[0]!.state).toBe('completed');

    await user.click(within(await screen.findByRole('list', { name: /waiting for a person/i })).getByText('Check certificate 2'));
    const other = await screen.findByLabelText('Step waiting for a person');
    await user.click(within(other).getByRole('button', { name: 'Cancel the run' }));
    expect(api.cancelled).toEqual([]);
    await user.click(within(other).getByRole('button', { name: 'Yes, cancel' }));
    expect(await screen.findByText(/Cancelled this run\. Nothing starts after this/)).toBeInTheDocument();
    expect(api.cancelled).toEqual(['run_2']);
  });

  it('records what happened to a call whose outcome is unknown; the reason is required and nothing is sent again', async () => {
    const api = new FakeXo();
    api.unknownEffects.push({
      definitionId: DEF,
      runId: `fe_${'a'.repeat(40)}`,
      parentRunId: 'run_9',
      item: 4,
      step: 'send',
      connector: 'mail',
    });
    const user = await inbox(api);
    expect(await screen.findByText(/Outcome unknown · mail · item 5/)).toBeInTheDocument();
    const card = await screen.findByLabelText('Call with an unknown outcome');
    expect(within(card).getByText(/item 5 of this run/)).toBeInTheDocument();
    const record = within(card).getByRole('button', { name: 'Record what happened' });
    expect(record).toBeDisabled();
    await user.click(within(card).getByLabelText(/It happened/));
    expect(record).toBeDisabled();
    await user.type(within(card).getByLabelText(/What you checked and found/), 'The email is in Sent, 20 Nov 10:01');
    await user.click(record);
    expect(await screen.findByText('Recorded. Nothing was sent again.')).toBeInTheDocument();
    expect(api.reconciled).toEqual([
      { runId: `fe_${'a'.repeat(40)}`, step: 'send', decision: 'confirmed_success', reason: 'The email is in Sent, 20 Nov 10:01' },
    ]);
    expect(api.cancelled).toEqual([]);
  });

  it('reads arguments as a person would: text as written, an attachment by name and content', () => {
    expect(argLines({ to: 'a@example.org', attachments: [{ filename: 'c.pdf', sha256: 'sha256:' + 'ab'.repeat(32) }], n: 2 })).toEqual([
      'to: a@example.org',
      `attachments: c.pdf (content ${'ab'.repeat(6)})`,
      'n: 2',
    ]);
  });

  it('on a phone the inbox controls are comfortable tap targets', () => {
    const cssPath = ['src/styles/inbox.css', 'apps/studio/src/styles/inbox.css'].map((p) => resolve(process.cwd(), p));
    const css = cssPath
      .map((p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return '';
        }
      })
      .join('');
    const media = css.slice(css.indexOf('@media (max-width: 44rem)'));
    expect(media).toContain('min-height: 2.75rem');
    expect(media).toContain('.cc-actions .btn');
  });
});
