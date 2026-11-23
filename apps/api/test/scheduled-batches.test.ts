/**
 * UW-16a (ADR 0051): a schedule slot of a workflow that can send things prepares a batch preview, to be approved in the Inbox, instead
 * of being refused. Nothing is sent until someone other than the schedule's owner approves exactly what it will do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { NonProductionAuditSink } from '@xo/audit';
import type { ExternalToolAdapter, ExternalToolResult } from '@xo/adapters';
import { AuditService } from '../src/audit/audit-service.js';
import { FsControlsStore } from '../src/workflow-controls/fs-controls-store.js';
import { runDueSchedules } from '../src/workflow-controls/scheduler.js';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { workspaceStateStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Mail', version: '1' },
  paths: {
    '/send': {
      post: {
        operationId: 'sendCertificate',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { to: { type: 'string' }, subject: { type: 'string' }, attachment: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
          },
        },
      },
    },
  },
});
const binding = (extra: Record<string, unknown> = {}) => ({
  capability: 'sendCertificate',
  connector: 'mail',
  kind: 'http',
  operation: 'send_certificate',
  sideEffect: 'irreversible',
  adapter: 'mail-adapter',
  ...extra,
});

function mailer() {
  const sent: { dispatchKey: string; to: string; attachment: string }[] = [];
  const adapter = {
    id: 'mail-adapter',
    approvalMode: 'capability',
    invoke: async (r: { dispatchKey: string; input: { to?: string; attachment?: string } }) => {
      sent.push({ dispatchKey: r.dispatchKey, to: String(r.input.to), attachment: String(r.input.attachment) });
      return { kind: 'confirmed_success', output: { id: `m_${sent.length}` } } as ExternalToolResult;
    },
  } as unknown as ExternalToolAdapter;
  return { adapter, sent };
}

const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ to: `person${i}@example.org`, subject: 'Your certificate', attachment: `sha256-${i}` }));

async function sched(
  fn: (e: {
    server: TestServer;
    mail: ReturnType<typeof mailer>;
    audit: NonProductionAuditSink;
    ws: string;
    cid: string;
    wf: string;
    base: string;
    certId: string;
    reviewer: Record<string, string>;
    controls: FsControlsStore;
    deps: Parameters<typeof runDueSchedules>[0];
  }) => Promise<void>,
): Promise<void> {
  await withTempDir('xo-api-sched-prev-', async (dir) => {
    const mail = mailer();
    const audit = new NonProductionAuditSink();
    const dataDir = join(dir, 'd');
    const workspacesDir = join(dir, 'w');
    const server = await TestServer.start({
      auditSink: audit,
      workspaceDataDir: dataDir,
      workspacesDir,
      ...NO_OCR,
      connectorAdapters: new Map([['mail-adapter', mail.adapter]]),
      runApproval: 'required',
      approvalSeparation: 'required',
    });
    try {
      const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
      const ws = workspace.workspaceId;
      assert.equal((await server.request('POST', `/workspaces/${ws}/members`, { identityId: 'reviewer-1', role: 'reviewer' })).status, 201);
      const reviewer = TestServer.authHeader((await server.issueAdditionalIdentity('reviewer-1')).apiKey);
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=mail.json`, Buffer.from(OPENAPI))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      assert.equal((await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [binding()] })).status, 200);
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
        inventory: { capabilities: { capabilityId: string }[] };
      }>().inventory;
      for (const c of inv.capabilities)
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (
        await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
          goal: { text: 'send a certificate', forEach: 'person' },
        })
      ).json<{ definition: { definitionId: string; candidateWorkflowId: string } }>().definition;
      const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
        certificateId: string;
        status: string;
      }>();
      assert.equal(cert.status, 'READY');
      const store = new FsWorkspaceStore(new LocalFsBlobStore(workspacesDir));
      const controls = new FsControlsStore(workspaceStateStore(workspace, { dataRootDir: dataDir }), ws);
      await controls.mutate(cid, def.candidateWorkflowId, 'test', new Date().toISOString(), (d) => ({ ...d, mode: 'live' }));
      const deps = {
        workspaceStore: store,
        dataConfig: {
          dataRootDir: dataDir,
          packageTrustPolicy: PackageTrustPolicy.development(),
          preExecution: { connectorAdapters: new Map([['mail-adapter', mail.adapter]]), runApproval: 'required' as const },
        },
        permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
        audit: new AuditService(new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS })),
      } as unknown as Parameters<typeof runDueSchedules>[0];
      await fn({
        server,
        mail,
        audit,
        ws,
        cid,
        wf: def.candidateWorkflowId,
        base: `/workspaces/${ws}/generated-workflows/${def.definitionId}`,
        certId: cert.certificateId,
        reviewer,
        controls,
        deps,
      });
    } finally {
      await server.stop();
    }
  });
}

type Sched = { everyMinutes: number; input?: unknown; certificateId?: string; items?: unknown };
const setSchedule = (e: { server: TestServer; ws: string; cid: string; wf: string }, s: Sched) =>
  e.server.request('PUT', `/workspaces/${e.ws}/workflow-controls/workflows/${e.wf}/triggers`, { compilationId: e.cid, schedule: s });

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

test('UW-16a: a start that names items is refused for a workflow that needs a batch approval', async () => {
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
