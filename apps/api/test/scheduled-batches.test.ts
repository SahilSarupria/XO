/**
 * UW-16a (ADR 0051): a schedule slot of a workflow that can send things prepares a batch preview, to be approved in the Inbox, instead
 * of being refused. Nothing is sent until someone other than the schedule's owner approves exactly what it will do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDueSchedules } from '../src/workflow-controls/scheduler.js';
import { people, sched, setSchedule } from './scheduled-batches-fixture.js';
import { withTempDir } from './test-helpers.js';

test('UW-16a: a slot of a workflow that sends things prepares a preview and sends nothing; the same slot prepares it once', async () => {
  await sched(async (e) => {
    assert.equal((await setSchedule(e, { everyMinutes: 10, input: { person_items: people(3) }, certificateId: e.certId })).status, 200);
    const due = new Date(Date.now() + 11 * 60_000);
    const fired = await runDueSchedules(e.deps, due);
    assert.deepEqual(fired, { started: 1, skipped: 0 }, (await e.controls.getDeployment(e.cid, e.wf))?.triggers.schedule?.lastOutcome);
    const dep = await e.controls.getDeployment(e.cid, e.wf);
    assert.match(dep?.triggers.schedule?.lastOutcome ?? '', /^preview prepared \(pvw_[0-9a-f]{24}\): waits for approval in the Inbox$/);
    assert.equal(e.mail.sent.length, 0, 'nothing was sent');
    const runs = (await e.server.request('GET', `${e.base}/runs`)).json<{ runs: unknown[] }>().runs;
    assert.equal(runs.length, 0, 'no run started');
    const inbox = (await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{
      batches: { state: string; total: number; preparedByYou: boolean }[];
    }>();
    assert.equal(inbox.batches.length, 1);
    assert.equal(inbox.batches[0]!.state, 'awaiting_approval');
    assert.equal(inbox.batches[0]!.total, 3);
    // Firing the same slot again (the engine records a slot once; a second instance would also reach the same preview id) prepares nothing new.
    await runDueSchedules(e.deps, due);
    assert.equal((await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{ batches: unknown[] }>().batches.length, 1);
  });
});

test('UW-16a: the prepared preview is approved by someone else and then starts exactly what was approved; the preparer cannot approve it', async () => {
  await sched(async (e) => {
    await setSchedule(e, { everyMinutes: 10, input: { person_items: people(4) }, certificateId: e.certId });
    await runDueSchedules(e.deps, new Date(Date.now() + 11 * 60_000));
    const inbox = (await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{
      batches: { previewId: string; root: string }[];
    }>();
    const b = inbox.batches[0]!;
    const own = await e.server.request('POST', `${e.base}/previews/${b.previewId}/approve`, { root: b.root });
    assert.equal(own.status, 409, 'the schedule belongs to the caller, so the caller cannot approve what it prepared');
    const ok = await e.server.request('POST', `${e.base}/previews/${b.previewId}/approve`, { root: b.root }, e.reviewer);
    assert.equal(ok.status, 201, ok.bodyText);
    const approvalId = ok.json<{ approval: { approvalId: string } }>().approval.approvalId;
    const run = await e.server.request('POST', `${e.base}/runs`, { certificateId: e.certId, batchApprovalId: approvalId });
    assert.equal(run.status, 201, run.bodyText);
    assert.equal(e.mail.sent.length, 4);
  });
});

test('UW-16a: the preview-prepared audit event carries ids and counts only', async () => {
  await sched(async (e) => {
    await setSchedule(e, { everyMinutes: 10, input: { person_items: people(2) }, certificateId: e.certId });
    await runDueSchedules(e.deps, new Date(Date.now() + 11 * 60_000));
    const events = (await e.server.request('GET', `/workspaces/${e.ws}/audit/events?event=generated-workflow.batch.previewed`)).json<{
      events: unknown[];
    }>();
    const text = JSON.stringify(events);
    assert.ok(!text.includes('example.org') && !text.includes('sha256-0'), 'no recipient or attachment in audit');
  });
});

test('UW-16a: a schedule naming items needs a certificate, cannot also give the list inline, and must name a real confirmed source', async () => {
  await sched(async (e) => {
    const items = { connectionId: 'src_000000000000000000000000', proposalId: 'prp_000000000000000000000000' };
    const noCert = await setSchedule(e, { everyMinutes: 10, items });
    assert.equal(noCert.status, 400, noCert.bodyText);
    const inline = await setSchedule(e, { everyMinutes: 10, input: { person_items: people(1) }, certificateId: e.certId, items });
    assert.ok(inline.status >= 400 && inline.status < 500, inline.bodyText);
    const unknown = await setSchedule(e, { everyMinutes: 10, certificateId: e.certId, items });
    assert.ok(unknown.status >= 400 && unknown.status < 500, unknown.bodyText);
    const stray = await setSchedule(e, { everyMinutes: 10, certificateId: e.certId, items: { connectionId: 5 } });
    assert.equal(stray.status, 400);
    assert.equal((await e.server.request('GET', `/workspaces/${e.ws}/workflow-controls/workflows/${e.wf}`)).status < 500, true);
  });
});

test('UW-16a: a start body that names items is refused (the start route takes only input, certificateId and batchApprovalId)', async () => {
  await sched(async (e) => {
    const r = await e.server.request('POST', `${e.base}/runs`, {
      certificateId: e.certId,
      items: { connectionId: 'src_000000000000000000000000', proposalId: 'prp_000000000000000000000000' },
    });
    assert.ok(r.status === 409 || r.status === 400, r.bodyText);
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16a: a slot has one preview id, and a second put of it is refused rather than replacing the first', async () => {
  await withTempDir('xo-api-slot-id-', async (dir) => {
    const { BatchStore, slotPreviewId } = await import('../src/approvals/batch-approval.js');
    assert.equal(slotPreviewId('wdef_a', 'schedule:10:5'), slotPreviewId('wdef_a', 'schedule:10:5'));
    assert.notEqual(slotPreviewId('wdef_a', 'schedule:10:5'), slotPreviewId('wdef_a', 'schedule:10:6'));
    assert.notEqual(slotPreviewId('wdef_a', 'schedule:10:5'), slotPreviewId('wdef_b', 'schedule:10:5'));
    assert.match(slotPreviewId('wdef_a', 'k'), /^pvw_[0-9a-f]{24}$/);
    const bs = new BatchStore(dir);
    const p = { previewId: slotPreviewId('wdef_a', 'k'), root: 'one' } as never;
    assert.equal(await bs.putPreviewOnce(p), 'created');
    assert.equal(await bs.putPreviewOnce({ ...(p as object), root: 'two' } as never), 'exists');
    assert.equal(((await bs.getPreview((p as { previewId: string }).previewId)) as { root: string }).root, 'one');
  });
});
