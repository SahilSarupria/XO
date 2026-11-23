/**
 * UW-16b (ADR 0051): a standing approval is a signed policy. Inside its bounds a run starts without a per-batch approval (each run
 * still has its own preview and its own batch approval); outside them the run falls back to an ordinary batch preview that waits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDueSchedules } from '../src/workflow-controls/scheduler.js';
import { people, sched, setSchedule } from './scheduled-batches-fixture.js';
import { standing } from './standing-approvals-fixture.js';

type Fallback = { status: number; body: { fallback?: boolean; reasons?: string[]; previewId?: string } };

test('UW-16b: a proposal shows counts of what it pins and never the values; it is not usable until someone else approves it', async () => {
  await sched(async (e) => {
    const s = await standing(e, { approve: false });
    const text = JSON.stringify(s.view);
    assert.ok(!text.includes('example.org') && !text.includes('sha256-'), 'no recipient or attachment in the view');
    assert.equal(s.view['status' as never], 'proposed');
    const early = (await s.start(2)) as Fallback;
    assert.equal(early.status, 202);
    assert.ok(early.body.reasons?.includes('not_approved'));
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b: inside the bounds a run starts and sends what the policy pins, with no per-batch approval', async () => {
  await sched(async (e) => {
    const s = await standing(e);
    const r = await s.start(3);
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body));
    assert.equal(e.mail.sent.length, 3);
    const detail = (await e.server.request('GET', `/workspaces/${e.ws}/standing-approvals/${s.id}`)).json<{
      uses: { items: number }[];
      usage: { runs: number; items: number };
    }>();
    assert.equal(detail.uses.length, 1);
    assert.equal(detail.usage.items, 3);
    assert.equal(detail.usage.runs, 1);
  });
});

test('UW-16b: an input the sample did not contain makes the run fall back to a batch preview; nothing is sent', async () => {
  await sched(async (e) => {
    const s = await standing(e, { n: 3 });
    const r = (await s.start(4)) as Fallback;
    assert.equal(r.status, 202);
    assert.ok(r.body.reasons?.includes('value_not_approved'), JSON.stringify(r.body));
    assert.equal(e.mail.sent.length, 0);
    const inbox = (await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{
      batches: { standingFallback?: { reasons: string[] } }[];
      standing: { fallbacks: unknown[] };
    }>();
    assert.equal(inbox.batches.length, 1);
    assert.ok(inbox.batches[0]!.standingFallback?.reasons.includes('value_not_approved'));
    assert.equal(inbox.standing.fallbacks.length, 1);
  });
});

test('UW-16b: more items than the run limit fall back; the limit is not exceeded by a run that just fits', async () => {
  await sched(async (e) => {
    const s = await standing(e, { n: 4, limits: { maxItemsPerRun: 4, maxItemsPerPeriod: 6, maxRunsPerPeriod: 5, period: 'day' } });
    assert.ok([200, 201].includes((await s.start(4, { idempotencyKey: 'a' })).status));
    const second = (await s.start(4, { idempotencyKey: 'b' })) as Fallback;
    assert.equal(second.status, 202);
    assert.ok(second.body.reasons?.includes('period_items'), JSON.stringify(second.body));
    assert.equal(e.mail.sent.length, 4);
  });
});

test('UW-16b: the number of runs per period is a limit too', async () => {
  await sched(async (e) => {
    const s = await standing(e, { n: 2, limits: { maxItemsPerRun: 2, maxItemsPerPeriod: 20, maxRunsPerPeriod: 1, period: 'day' } });
    assert.ok([200, 201].includes((await s.start(2, { idempotencyKey: 'a' })).status));
    const second = (await s.start(2, { idempotencyKey: 'b' })) as Fallback;
    assert.equal(second.status, 202);
    assert.ok(second.body.reasons?.includes('period_runs'), JSON.stringify(second.body));
  });
});

test('UW-16b: a retry with the same idempotency key is the same run and sends once', async () => {
  await sched(async (e) => {
    const s = await standing(e);
    const a = await s.start(3, { idempotencyKey: 'same' });
    const b = await s.start(3, { idempotencyKey: 'same' });
    assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status), JSON.stringify(b.body));
    assert.equal(e.mail.sent.length, 3);
  });
});

test('UW-16b: revoking stops new runs at once; they fall back instead', async () => {
  await sched(async (e) => {
    const s = await standing(e);
    const rv = await e.server.request('POST', `/workspaces/${e.ws}/standing-approvals/${s.id}/revoke`, { reason: 'stop' });
    assert.equal(rv.status, 200, rv.bodyText);
    const again = await e.server.request('POST', `/workspaces/${e.ws}/standing-approvals/${s.id}/revoke`, { reason: 'again' });
    assert.equal(again.status, 200);
    const r = (await s.start(2)) as Fallback;
    assert.equal(r.status, 202);
    assert.ok(r.body.reasons?.includes('revoked'));
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b: a standing approval stops being usable when it expires', async () => {
  await sched(async (e) => {
    const s = await standing(e, { expiresInDays: 1 });
    const later = new Date(Date.now() + 2 * 86_400_000);
    const r = (await s.start(2, { now: later })) as Fallback;
    assert.equal(r.status, 202);
    assert.ok(r.body.reasons?.includes('expired'));
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b: a schedule under a standing approval sends inside the bounds and records a fall-back outside them', async () => {
  await sched(async (e) => {
    const s = await standing(e, { n: 3 });
    const set = await setSchedule(e, {
      everyMinutes: 10,
      input: { person_items: people(3) },
      certificateId: e.certId,
      standingApprovalId: s.id,
    } as never);
    assert.equal(set.status, 200, set.bodyText);
    const fired = await runDueSchedules(e.deps, new Date(Date.now() + 11 * 60_000));
    assert.deepEqual(fired, { started: 1, skipped: 0 }, (await e.controls.getDeployment(e.cid, e.wf))?.triggers.schedule?.lastOutcome);
    assert.equal(e.mail.sent.length, 3);
    // The next slot brings someone the sample did not contain: it falls back and waits in the Inbox.
    await setSchedule(e, {
      everyMinutes: 10,
      input: { person_items: people(4) },
      certificateId: e.certId,
      standingApprovalId: s.id,
    } as never);
    await runDueSchedules(e.deps, new Date(Date.now() + 25 * 60_000));
    const out = (await e.controls.getDeployment(e.cid, e.wf))?.triggers.schedule?.lastOutcome ?? '';
    assert.match(out, /fell back to a batch approval \(.*value_not_approved.*\): preview pvw_[0-9a-f]{24} waits in the Inbox/);
    assert.equal(e.mail.sent.length, 3, 'nothing more was sent');
  });
});

test('UW-16b: a schedule cannot use a standing approval that is not active, or that names someone else to start', async () => {
  await sched(async (e) => {
    const s = await standing(e, { approve: false });
    const unapproved = await setSchedule(e, { everyMinutes: 10, certificateId: e.certId, standingApprovalId: s.id } as never);
    assert.equal(unapproved.status, 412, unapproved.bodyText);
    await s.approve();
    await e.server.request('POST', `/workspaces/${e.ws}/standing-approvals/${s.id}/revoke`, { reason: 'x' });
    const revoked = await setSchedule(e, { everyMinutes: 10, certificateId: e.certId, standingApprovalId: s.id } as never);
    assert.equal(revoked.status, 412, revoked.bodyText);
    const noCert = await setSchedule(e, { everyMinutes: 10, standingApprovalId: s.id } as never);
    assert.equal(noCert.status, 400);
  });
});

test('UW-16b: a batch approval that has not been used can be revoked, and the start with it is then refused', async () => {
  await sched(async (e) => {
    await setSchedule(e, { everyMinutes: 10, input: { person_items: people(2) }, certificateId: e.certId });
    await runDueSchedules(e.deps, new Date(Date.now() + 11 * 60_000));
    const b = (await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{
      batches: { previewId: string; root: string }[];
    }>().batches[0]!;
    const ok = await e.server.request('POST', `${e.base}/previews/${b.previewId}/approve`, { root: b.root }, e.reviewer);
    const approvalId = ok.json<{ approval: { approvalId: string } }>().approval.approvalId;
    const rv = await e.server.request(
      'POST',
      `${e.base}/previews/${b.previewId}/approval/revoke`,
      { reason: 'changed my mind' },
      e.reviewer,
    );
    assert.equal(rv.status, 200, rv.bodyText);
    const run = await e.server.request('POST', `${e.base}/runs`, { certificateId: e.certId, batchApprovalId: approvalId });
    assert.ok(run.status >= 400 && run.status < 500, run.bodyText);
    assert.equal(e.mail.sent.length, 0);
  });
});
