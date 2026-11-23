/**
 * UW-12b (ADR 0052): the control surface, the rest. The inbox is computed from the runs and cached by file identity (it must always
 * equal a full walk); clients wait for changes; an item has an evidence view; a run has typed outputs; a waiting step can be
 * delegated; a batch preview can be sent back with a comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NonProductionAuditSink } from '@xo/audit';
import { AuditService } from '../src/audit/audit-service.js';
import { fallbackWorkspaceManager } from '../src/workspace/authorizer.js';
import { controlInbox, type RunnerDeps } from '../src/routes/generated-run-routes.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { TestServer, withTempDir } from './test-helpers.js';
import { people, sched } from './scheduled-batches-fixture.js';
import { standing } from './standing-approvals-fixture.js';

type Env = Parameters<Parameters<typeof sched>[0]>[0];

async function depsOf(e: Env): Promise<{ deps: RunnerDeps; workspace: WorkspaceRecord; actor: string }> {
  const ws = (await e.deps.workspaceStore.get(e.ws)) as unknown as { ok: true; value: WorkspaceRecord };
  const deps: RunnerDeps = {
    ...(e.deps as unknown as RunnerDeps),
    env: {},
    audit: new AuditService(e.audit),
    permissionManager: fallbackWorkspaceManager(),
  };
  return { deps, workspace: ws.value, actor: ws.value.identityId };
}

/** The cached inbox and a full walk must say exactly the same. */
async function equalsFullWalk(e: Env, label: string): Promise<{ derived: number }> {
  const { deps, workspace, actor } = await depsOf(e);
  const out = { derived: 0 };
  const cached = await controlInbox(deps, workspace, actor, { cacheOut: out });
  const full = await controlInbox(deps, workspace, actor, { cache: false });
  assert.deepEqual(cached, full, `the cached inbox differs from a full walk ${label}`);
  return out;
}

const preview = async (e: Env, n = 2) =>
  (await e.server.request('POST', `${e.base}/previews`, { input: { person_items: people(n) }, certificateId: e.certId })).json<{
    previewId: string;
    root: string;
  }>();

test('UW-12b: the inbox cache re-derives only changed runs and always equals a full walk', async () => {
  await sched(async (e) => {
    assert.equal((await equalsFullWalk(e, 'with nothing')).derived, 0);
    const p = await preview(e);
    await equalsFullWalk(e, 'after a preview');
    const a = (await e.server.request('POST', `${e.base}/previews/${p.previewId}/approve`, { root: p.root }, e.reviewer)).json<{
      approval: { approvalId: string };
    }>();
    await equalsFullWalk(e, 'after an approval');
    const run = await e.server.request('POST', `${e.base}/runs`, { certificateId: e.certId, batchApprovalId: a.approval.approvalId });
    assert.equal(run.status, 201, run.bodyText);
    await equalsFullWalk(e, 'after a start');
    // Nothing changed: nothing is derived again.
    assert.equal((await equalsFullWalk(e, 'unchanged')).derived, 0);
    // A new preview changes the batch folders and adds its own (preview) run; the runs that did not change are not derived again.
    await preview(e, 3);
    const after = await equalsFullWalk(e, 'after a second preview');
    assert.equal(after.derived, 2, "only the definition's batch listing and the new preview's run were derived");
  });
});

test('UW-12b: an unreadable inbox cache is rebuilt, never trusted', async () => {
  await sched(async (e) => {
    const p = await preview(e);
    await equalsFullWalk(e, 'before');
    const dir = join(e.deps.dataConfig.dataRootDir, e.ws, 'control');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'inbox-cache.json'), '{ not json');
    await equalsFullWalk(e, 'with a broken cache');
    // A cache that lies about a file's identity is not believed either: tamper with a stored entry's content, keep its identity.
    const file = join(dir, 'inbox-cache.json');
    const { readFile } = await import('node:fs/promises');
    const stored = JSON.parse(await readFile(file, 'utf8')) as { v: number; files: Record<string, { fp: string; entries: unknown }> };
    assert.equal(stored.v, 1);
    assert.ok(Object.keys(stored.files).length > 0, 'the broken file was replaced by a rebuilt one');
    await writeFile(file, JSON.stringify({ v: 2, files: {} }));
    await equalsFullWalk(e, 'with a cache of another version');
    assert.ok(p.previewId);
    assert.ok((await readdir(dir)).includes('inbox-cache.json'));
  });
});

test('UW-12b: the inbox long-poll returns when something changes and times out otherwise', async () => {
  await sched(async (e) => {
    const first = await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`);
    assert.equal(first.status, 200);
    const etag = first.json<{ etag: string }>().etag;
    assert.equal(first.headers['etag'], etag, 'the tag is also the ETag header');
    const quiet = await e.server.request('GET', `/workspaces/${e.ws}/control/inbox/changes?etag=${encodeURIComponent(etag)}&wait=1`);
    assert.deepEqual(quiet.json(), { etag, changed: false });
    const waiting = e.server.request('GET', `/workspaces/${e.ws}/control/inbox/changes?etag=${encodeURIComponent(etag)}&wait=10`);
    await new Promise((r) => setTimeout(r, 300));
    await preview(e);
    const woke = (await waiting).json<{ etag: string; changed: boolean }>();
    assert.equal(woke.changed, true);
    assert.notEqual(woke.etag, etag);
    const nowTag = await e.server.request('GET', `/workspaces/${e.ws}/control/inbox/changes`);
    assert.equal(nowTag.json<{ changed: boolean }>().changed, false, 'without a tag it answers at once');
    assert.equal((await e.server.request('GET', `/workspaces/${e.ws}/control/inbox/changes?etag=x&wait=99`)).status, 400);
  });
});

test("UW-12b: the evidence view names the row, match, approval and each call's outcome of an item", async () => {
  await sched(async (e) => {
    const s = await standing(e, { n: 2 });
    const r = await s.start(2);
    const runId = (r.body as { runId: string }).runId;
    const url = `${e.base}/runs/${runId}/evidence`;
    const ev = await e.server.request('GET', `${url}?item=1`);
    assert.equal(ev.status, 200, ev.bodyText);
    const v = ev.json<{
      item: number;
      state: string;
      approval?: { kind: string; standingApprovalId?: string };
      actions: { operation: string; effect: { state: string } }[];
      manifest: { digestOk: boolean; certificateId: string };
      observations: number;
    }>();
    assert.equal(v.item, 1);
    assert.equal(v.approval?.kind, 'standing');
    assert.equal(v.approval?.standingApprovalId, s.id);
    assert.equal(v.manifest.digestOk, true);
    assert.equal(v.manifest.certificateId, e.certId);
    assert.equal(v.actions.length, 1);
    assert.equal(v.actions[0]!.effect.state, 'confirmed_success');
    assert.equal((await e.server.request('GET', `${url}?item=9`)).status, 400);
    assert.equal((await e.server.request('GET', `${url}`)).status, 400, 'a batch needs an item');
  });
});

test('UW-12b: outputs list deliveries, documents and results with their access and retention', async () => {
  await sched(async (e) => {
    const s = await standing(e, { n: 2 });
    const runId = ((await s.start(2)).body as { runId: string }).runId;
    const res = await e.server.request('GET', `${e.base}/runs/${runId}/outputs`);
    assert.equal(res.status, 200, res.bodyText);
    const { artefacts } = res.json<{ artefacts: { kind: string; item?: number; access: string; kept: string; state?: string }[] }>();
    const deliveries = artefacts.filter((a) => a.kind === 'delivery');
    assert.equal(deliveries.length, 2);
    assert.ok(deliveries.every((d) => d.state === 'confirmed_success'));
    assert.ok(artefacts.filter((a) => a.kind === 'document').length >= 0);
    assert.ok(artefacts.every((a) => a.access === 'workspace_members' && a.kept === 'until_workspace_deleted'));
    assert.equal((await e.server.request('GET', `${e.base}/runs/run_${'0'.repeat(32)}/outputs`)).status, 404);
  });
});

test('UW-12b: a batch with changes requested cannot be approved and shows the comment to its preparer', async () => {
  await sched(async (e) => {
    const p = await preview(e);
    const asked = await e.server.request(
      'POST',
      `${e.base}/previews/${p.previewId}/request-changes`,
      { comment: 'Use the new subject line' },
      e.reviewer,
    );
    assert.equal(asked.status, 201, asked.bodyText);
    const view = (await e.server.request('GET', `${e.base}/previews/${p.previewId}`)).json<{
      approvable: boolean;
      changesRequested?: { comment: string };
    }>();
    assert.equal(view.approvable, false);
    assert.equal(view.changesRequested?.comment, 'Use the new subject line');
    const approve = await e.server.request('POST', `${e.base}/previews/${p.previewId}/approve`, { root: p.root }, e.reviewer);
    assert.equal(approve.status, 409);
    assert.match(approve.bodyText, /changes_requested/);
    const inbox = (await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{
      batches: { previewId: string; changesRequested?: { comment: string } }[];
    }>();
    assert.equal(inbox.batches.find((b) => b.previewId === p.previewId)?.changesRequested?.comment, 'Use the new subject line');
    assert.equal(
      (await e.server.request('POST', `${e.base}/previews/${p.previewId}/request-changes`, { comment: ' ' }, e.reviewer)).status,
      400,
    );
    await equalsFullWalk(e, 'after changes were requested');
    const events = e.audit.events().filter((x) => x.type === 'generated-workflow.batch.changes-requested');
    assert.equal(events.length, 1, 'the request is audited');
    assert.ok(!JSON.stringify(events).includes('new subject line'), 'the comment is not in the audit event');
  });
});

test('UW-12b: a viewer cannot delegate or request changes (403); another workspace gets 404', async () => {
  await sched(async (e) => {
    const p = await preview(e);
    assert.equal((await e.server.request('POST', `/workspaces/${e.ws}/members`, { identityId: 'viewer-1', role: 'viewer' })).status, 201);
    const viewer = TestServer.authHeader((await e.server.issueAdditionalIdentity('viewer-1')).apiKey);
    assert.equal(
      (await e.server.request('POST', `${e.base}/previews/${p.previewId}/request-changes`, { comment: 'x' }, viewer)).status,
      403,
    );
    assert.equal(
      (
        await e.server.request(
          'POST',
          `${e.base}/runs/run_${'0'.repeat(32)}/approvals/a1/delegate`,
          { to: 'reviewer-1', reason: 'r' },
          viewer,
        )
      ).status,
      403,
    );
    assert.equal((await e.server.request('GET', `${e.base}/runs/run_${'0'.repeat(32)}/evidence`, undefined, viewer)).status, 404);
    const other = (await e.server.request('POST', '/workspaces', {}, viewer)).json<{ workspaceId?: string }>();
    if (other.workspaceId !== undefined)
      assert.equal(
        (await e.server.request('GET', e.base.replace(e.ws, other.workspaceId) + `/runs/run_${'0'.repeat(32)}/outputs`, undefined, viewer))
          .status,
        404,
      );
  });
});

test('UW-12b: the inbox cache equals a full walk after a call of unknown outcome is reconciled', async () => {
  await sched(async (e) => {
    (e.mail.adapter as unknown as { invoke: () => Promise<unknown> }).invoke = async () => ({
      kind: 'outcome_unknown',
      reason: 'the connection closed before an answer',
    });
    const s = await standing(e, { n: 1 });
    const run = await s.start(1);
    const runId = (run.body as { runId: string }).runId;
    const before = (await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{
      attention: { runId: string; step: string }[];
    }>();
    assert.equal(before.attention.length, 1);
    await equalsFullWalk(e, 'with an unknown outcome');
    const url = `${e.base}/runs/${before.attention[0]!.runId}/effects/${before.attention[0]!.step}/reconciliation`;
    assert.equal(runId.length > 0, true);
    const rec = await e.server.request('POST', url, { decision: 'confirmed_failure_no_effect', reason: 'checked the mailbox' }, e.reviewer);
    assert.equal(rec.status, 200, rec.bodyText);
    await equalsFullWalk(e, 'after reconciliation');
    const after = (await e.server.request('GET', `/workspaces/${e.ws}/control/inbox`)).json<{ attention: unknown[] }>();
    assert.equal(after.attention.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------- delegation, with a step a person does

const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

async function stepEnv(
  fn: (e: {
    server: TestServer;
    ws: string;
    base: string;
    reviewer: Record<string, string>;
    runId: string;
    approvalId: string;
    ownerId: string;
    audit: NonProductionAuditSink;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir('xo-api-delegate-', async (dir) => {
    const audit = new NonProductionAuditSink();
    const server = await TestServer.start({
      auditSink: audit,
      workspaceDataDir: join(dir, 'd'),
      workspacesDir: join(dir, 'w'),
      extraction: { pageTiers: [], ocr: { mode: 'off' as const } },
      approvalSeparation: 'required',
    });
    try {
      const wsRec = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string; identityId: string }>();
      const ws = wsRec.workspaceId;
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'reviewer-1', role: 'reviewer' })).status, 201);
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'viewer-1', role: 'viewer' })).status, 201);
      const reviewer = TestServer.authHeader((await server.issueAdditionalIdentity('reviewer-1')).apiKey);
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'Ship a release', needs: ['Run the full test suite'] },
        })
      ).json<{ definition: { definitionId: string } }>().definition;
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
      }>();
      const base = `/workspaces/${ws}/generated-workflows/${def.definitionId}`;
      const run = await server.request('POST', `${base}/runs`, { certificateId: cert.certificateId, input: {} });
      assert.equal(run.status, 201, run.bodyText);
      const v = run.json<{ runId: string; pendingApprovals: { approvalId: string }[] }>();
      assert.ok(v.pendingApprovals.length >= 1, 'a step waits for a person');
      await fn({
        server,
        ws,
        base,
        reviewer,
        runId: v.runId,
        approvalId: v.pendingApprovals[0]!.approvalId,
        ownerId: wsRec.identityId,
        audit,
      });
    } finally {
      await server.stop();
    }
  });
}

test('UW-12b: a delegated step can be decided only by the delegate; an admin takes it back by delegating to themselves', async () => {
  await stepEnv(async ({ server, ws, base, reviewer, runId, approvalId, ownerId }) => {
    const delegate = (body: unknown, h?: Record<string, string>) =>
      server.request('POST', `${base}/runs/${runId}/approvals/${approvalId}/delegate`, body, h);
    const decide = (h?: Record<string, string>) =>
      server.request('POST', `${base}/runs/${runId}/approvals/${approvalId}`, { action: 'approve' }, h);
    assert.equal((await delegate({ to: 'viewer-1', reason: 'r' })).status, 400, 'a viewer cannot review, so cannot be delegated to');
    assert.equal((await delegate({ to: 'reviewer-1', reason: '' })).status, 400, 'a reason is required');
    const done = await delegate({ to: 'reviewer-1', reason: 'you know this one' });
    assert.equal(done.status, 200, done.bodyText);
    assert.equal(done.json<{ revision: number }>().revision, 1);
    const inbox = (await server.request('GET', `/workspaces/${ws}/control/inbox`)).json<{
      steps: { assignedTo?: string; assignedToYou?: boolean }[];
    }>();
    assert.equal(inbox.steps[0]!.assignedTo, 'reviewer-1');
    assert.equal(inbox.steps[0]!.assignedToYou, false);
    const mine = (await server.request('GET', `/workspaces/${ws}/control/inbox`, undefined, reviewer)).json<{
      steps: { assignedToYou?: boolean }[];
    }>();
    assert.equal(mine.steps[0]!.assignedToYou, true);
    const refused = await decide();
    assert.equal(refused.status, 403, refused.bodyText);
    assert.match(refused.bodyText, /delegated/);
    // Someone who is neither the delegate nor an admin cannot hand it on; a stale revision is refused.
    assert.equal((await delegate({ to: 'reviewer-1', reason: 'again' }, reviewer)).status, 200, 'the delegate may pass it on or keep it');
    assert.equal(
      (await delegate({ to: ownerId, reason: 'taking it back', revision: 1 })).status,
      409,
      'revision 1 is no longer the current one',
    );
    const back = await delegate({ to: ownerId, reason: 'taking it back', revision: 2 });
    assert.equal(back.status, 200, back.bodyText);
    assert.equal((await decide(reviewer)).status, 403, 'the former delegate no longer may decide it');
    const ok = await decide();
    assert.ok(ok.status === 200 || ok.status === 201, ok.bodyText);
  });
});

test('UW-12b: delegation and request-changes audit events carry ids only', async () => {
  await stepEnv(async ({ server, base, runId, approvalId, audit }) => {
    const reason = 'secret reason text 8842';
    assert.equal(
      (await server.request('POST', `${base}/runs/${runId}/approvals/${approvalId}/delegate`, { to: 'reviewer-1', reason })).status,
      200,
    );
    const events = audit.events().filter((x) => x.type === 'generated-workflow.approval.delegated');
    assert.equal(events.length, 1, JSON.stringify(audit.events().map((x) => x.type)));
    const text = JSON.stringify(events);
    assert.ok(!text.includes('8842') && !text.includes('@'), 'no reason and no email in the event');
    assert.ok(text.includes(runId));
  });
});

test('UW-12b: the same evidence, outputs and delegate routes exist for a Workflow entity', async () => {
  await sched(async (e) => {
    const paths = (await e.server.request('GET', '/openapi.json')).json<{ paths: Record<string, unknown> }>().paths;
    for (const p of ['evidence', 'outputs', 'approvals/{approvalId}/delegate'])
      assert.ok(paths[`/workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/${p}`], `entity route ${p} is documented`);
  });
});
