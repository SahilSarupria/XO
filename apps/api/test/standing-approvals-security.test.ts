/**
 * UW-16b (ADR 0051): what must never happen. A key or a service cannot approve; nobody approves their own proposal; a changed or
 * forged policy is not used; only the named person starts; nothing sent without the bounds; and no recipient or value reaches the audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
import { sched } from './scheduled-batches-fixture.js';
import { human, session, standing } from './standing-approvals-fixture.js';

type Fallback = { status: number; body: { fallback?: boolean; reasons?: string[] } };

test('UW-16b/S1: a key or a service principal cannot approve a standing approval, and nothing runs under it', async () => {
  await sched(async (e) => {
    const s = await standing(e, { approve: false });
    assert.equal(await s.refused(s.approve(s.view.policyDigest, s.reviewer, { credential: 'api-key' })), 'standing_requires_person');
    assert.equal(await s.refused(s.approve(s.view.policyDigest, s.reviewer, null)), 'standing_requires_person');
    const svc = establishAuthenticatedPrincipal({ kind: 'service', id: 'reviewer-1' });
    if (!svc.ok) throw svc.error;
    assert.equal(await s.refused(s.approve(s.view.policyDigest, svc.value, session())), 'standing_requires_person');
    // Over HTTP, a reviewer's API key is refused too (no recent sign-in, and not a person).
    const http = await e.server.request(
      'POST',
      `/workspaces/${e.ws}/standing-approvals/${s.id}/approve`,
      { policyDigest: s.view.policyDigest },
      e.reviewer,
    );
    assert.ok(http.status >= 400 && http.status < 500, http.bodyText);
    assert.equal(((await s.start(3)) as Fallback).status, 202);
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b/S2: the proposer, and the person runs start as, cannot approve it', async () => {
  await sched(async (e) => {
    const s = await standing(e, { approve: false });
    assert.equal(await s.refused(s.approve(s.view.policyDigest, s.owner)), 'separation_of_duties');
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b/S3: approving a digest other than the one shown is refused, and a returned proposal cannot be approved', async () => {
  await sched(async (e) => {
    const s = await standing(e, { approve: false });
    assert.equal(await s.refused(s.approve('sha256:' + '0'.repeat(64))), 'policy_mismatch');
    const { requestStandingChanges } = await import('../src/approvals/standing-approval.js');
    await requestStandingChanges(s.deps, { workspace: s.workspace, actor: s.reviewer, id: s.id, comment: 'narrow it', correlationId: 'c' });
    assert.equal(await s.refused(s.approve()), 'not_proposed');
  });
});

test('UW-16b/S4: a sample older than 24 hours cannot be approved', async () => {
  await sched(async (e) => {
    const s = await standing(e, { approve: false });
    const { approveStanding } = await import('../src/approvals/standing-approval.js');
    const late = approveStanding(s.deps, {
      workspace: s.workspace,
      actor: s.reviewer,
      auth: session(),
      definition: s.definition,
      id: s.id,
      policyDigest: s.view.policyDigest,
      correlationId: 'c',
      now: new Date(Date.now() + 25 * 3_600_000),
    });
    assert.equal(await s.refused(late), 'sample_expired');
  });
});

test('UW-16b/S5: only the person it names starts a run, and only through a trigger it allows', async () => {
  await sched(async (e) => {
    const s = await standing(e, { triggers: ['manual'] });
    assert.equal(await s.refused(s.start(3, { actor: s.reviewer })), 'starter_mismatch');
    assert.equal(await s.refused(s.start(3, { trigger: 'schedule' })), 'trigger_not_allowed');
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b/S6: a policy whose stored approval was altered does not verify and starts nothing', async () => {
  await sched(async (e) => {
    const s = await standing(e);
    const file = join(s.deps.dataConfig.dataRootDir, s.workspace.workspaceId, 'standing-approvals', s.id, 'proposal.json');
    const p = JSON.parse(await readFile(file, 'utf8')) as { policy: { limits: { maxItemsPerRun: number } } };
    p.policy.limits.maxItemsPerRun = 5000;
    await writeFile(file, JSON.stringify(p));
    assert.equal(await s.refused(s.start(3)), 'signature');
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b/S7: changing who receives (same size of input, other recipients) is not covered by the approval', async () => {
  await sched(async (e) => {
    const s = await standing(e, { n: 3 });
    const other = Array.from({ length: 3 }, (_, i) => ({
      to: `attacker${i}@example.net`,
      subject: 'Your certificate',
      attachment: `sha256-${i}`,
    }));
    const r = (await s.start(3, { input: { person_items: other } })) as Fallback;
    assert.equal(r.status, 202);
    assert.ok(r.body.reasons?.includes('value_not_approved') || r.body.reasons?.includes('input_changed'), JSON.stringify(r.body));
    assert.equal(e.mail.sent.length, 0);
  });
});

test('UW-16b/S8: the audit trail and the views carry ids and counts only, never a recipient, value or digest', async () => {
  await sched(async (e) => {
    const s = await standing(e);
    await s.start(3);
    await s.start(4); // falls back
    const audit = JSON.stringify(e.audit.events());
    for (const bad of ['example.org', 'attacker', 'sha256-0', 'person0']) assert.ok(!audit.includes(bad), `audit contains ${bad}`);
    assert.ok(e.audit.events().some((x) => x.type === 'standing-approval.used'));
    assert.ok(e.audit.events().some((x) => x.type === 'standing-approval.fallback'));
    const view = (await e.server.request('GET', `/workspaces/${e.ws}/standing-approvals/${s.id}`)).bodyText;
    for (const bad of ['example.org', 'person0', 'sha256-0']) assert.ok(!view.includes(bad), `view contains ${bad}`);
  });
});

test('UW-16b/S9: a person without the author role cannot propose, start or revoke; a viewer-level key is refused before anything is read', async () => {
  await sched(async (e) => {
    const s = await standing(e);
    const base = `/workspaces/${e.ws}/standing-approvals`;
    await e.server.request('POST', `/workspaces/${e.ws}/members`, { identityId: 'viewer-1', role: 'viewer' });
    const viewer = (await import('./test-helpers.js')).TestServer.authHeader((await e.server.issueAdditionalIdentity('viewer-1')).apiKey);
    for (const [path, body] of [
      [base, {}],
      [`${base}/${s.id}/runs`, {}],
      [`${base}/${s.id}/revoke`, { reason: 'x' }],
      [`${base}/${s.id}/approve`, { policyDigest: 'x' }],
    ] as const) {
      const r = await e.server.request('POST', path, body, viewer);
      assert.equal(r.status, 403, `${path}: ${r.bodyText}`);
    }
    assert.equal((await e.server.request('GET', `${base}/${s.id}`, undefined, viewer)).status, 200, 'a viewer may read it');
    assert.equal(human('x').kind, 'human');
  });
});
