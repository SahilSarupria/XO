/** Shared fixture for the UW-16 tests: a workspace with a certified, live, per-person mail workflow and a scheduler. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { fallbackWorkspaceManager } from '../src/workspace/authorizer.js';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { NonProductionAuditSink } from '@xo/audit';
import type { ExternalToolAdapter, ExternalToolResult } from '@xo/adapters';
import { AuditService } from '../src/audit/audit-service.js';
import { FsControlsStore } from '../src/workflow-controls/fs-controls-store.js';
import type { runDueSchedules } from '../src/workflow-controls/scheduler.js';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { workspaceStateStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { TestServer, withTempDir } from './test-helpers.js';

export const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
export const OPENAPI = JSON.stringify({
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
export const binding = (extra: Record<string, unknown> = {}) => ({
  capability: 'sendCertificate',
  connector: 'mail',
  kind: 'http',
  operation: 'send_certificate',
  sideEffect: 'irreversible',
  adapter: 'mail-adapter',
  ...extra,
});

export function mailer() {
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

export const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ to: `person${i}@example.org`, subject: 'Your certificate', attachment: `sha256-${i}` }));

export async function sched(
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
        permissionManager: fallbackWorkspaceManager(),
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

export type Sched = { everyMinutes: number; input?: unknown; certificateId?: string; items?: unknown };
export const setSchedule = (e: { server: TestServer; ws: string; cid: string; wf: string }, s: Sched) =>
  e.server.request('PUT', `/workspaces/${e.ws}/workflow-controls/workflows/${e.wf}/triggers`, { compilationId: e.cid, schedule: s });
