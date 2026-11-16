/**
 * ADR 0035 — the composed-workflow runner is retired wherever readiness certificates are required.
 *
 * Before: only the HTTP start route checked the certificate. A schedule, a webhook or the draft launcher reached the composed runner
 * directly, so a workspace that required certificates could still run uncertified workflows through a trigger. Now every composed
 * start passes one fence, and webhooks and schedules that name a certificate run the certified workflow on the Workflow IR runtime.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { AuditService } from '../src/audit/audit-service.js';
import { NonProductionAuditSink } from '@xo/audit';
import { FsControlsStore } from '../src/workflow-controls/fs-controls-store.js';
import { runDueSchedules } from '../src/workflow-controls/scheduler.js';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { workspaceStateStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

type Err = { error: { code: string; context?: { reason?: string } } };

test('a certificate-requiring workspace: no trigger reaches the composed runner; certified webhooks and schedules run on the workflow runtime', async () => {
  await withTempDir('xo-api-retire-', async (dataDir) => {
    await withTempDir('xo-api-retire-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, ...NO_OCR });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const ws = workspace.workspaceId;
        const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(TEXT))).json<{
          sourceId: string;
        }>();
        const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
          .compilationId;
        const gen = (
          await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, {
            goal: { text: 'Ship a release', needs: ['Run the full test suite'] },
          })
        ).json<{ definition: { definitionId: string; candidateWorkflowId: string } }>().definition;
        const wf = gen.candidateWorkflowId;
        const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
          inventory: { capabilities: { capabilityId: string }[] };
        }>().inventory;
        for (const c of inv.capabilities)
          await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
        const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/readiness`, {})).json<{
          certificateId: string;
          status: string;
        }>();
        assert.equal(cert.status, 'READY');

        assert.equal(
          (await server.request('PUT', `/workspaces/${ws}/settings`, { trust: { requireReadinessCertificate: true } })).status,
          200,
        );
        const ctl = (what: string) => `/workspaces/${ws}/workflow-controls/workflows/${wf}/${what}`;
        assert.equal((await server.request('PUT', ctl('triggers'), { compilationId: cid, webhook: true })).status, 200);
        // Test setup: put the workflow live directly. Going live through the controls checklist (practice runs, sign-off,
        // limits) has its own tests; here only the start path matters.
        const controls = new FsControlsStore(workspaceStateStore(workspace, { dataRootDir: dataDir }), ws);
        await controls.mutate(cid, wf, 'test', new Date().toISOString(), (d) => ({ ...d, mode: 'live' }));

        // The fence: an uncertified webhook start is refused, not run on the composed runner.
        const fenced = await server.request('POST', `/workspaces/${ws}/workflows/${wf}/webhook`, { compilationId: cid, input: {} });
        assert.equal(fenced.status, 409, fenced.bodyText);
        assert.equal(fenced.json<Err>().error.code, 'XO_WORKFLOW_REQUIRES_IR_RUNTIME');
        assert.equal(fenced.json<Err>().error.context?.reason, 'composed_runner_retired');
        assert.equal(
          (await server.request('GET', `/workspaces/${ws}/workflow-executions`)).json<{ workflowExecutions: unknown[] }>()
            .workflowExecutions.length,
          0,
          'nothing started on the composed runner',
        );

        // A certified start on the composed route names the workflow runtime, whatever its constructs.
        const composed = await server.request('POST', `/workspaces/${ws}/workflows/${wf}/executions`, {
          compilationId: cid,
          input: {},
          certificateId: cert.certificateId,
        });
        assert.equal(composed.status, 409);
        assert.equal(composed.json<Err>().error.code, 'XO_WORKFLOW_REQUIRES_IR_RUNTIME');

        // A certified webhook runs on the workflow runtime; the same key is the same run.
        const hook = () =>
          server.request(
            'POST',
            `/workspaces/${ws}/workflows/${wf}/webhook`,
            { compilationId: cid, input: {}, certificateId: cert.certificateId },
            { 'idempotency-key': 'webhook-call-1' },
          );
        const h1 = await hook();
        assert.ok(h1.status === 201 || h1.status === 200, h1.bodyText);
        const runId = h1.json<{ runId: string }>().runId;
        assert.match(runId, /^run_[0-9a-f]{32}$/);
        assert.equal((await hook()).json<{ runId: string }>().runId, runId);
        const wrong = await server.request('POST', `/workspaces/${ws}/workflows/${wf}/webhook`, {
          compilationId: 'cmp_other',
          input: {},
          certificateId: cert.certificateId,
        });
        assert.ok(wrong.status >= 400 && wrong.status < 500, wrong.bodyText);

        // Schedules: an uncertified one is refused when set; a certified one starts as the person who set it.
        const setSchedule = (extra: object) =>
          server.request('PUT', ctl('triggers'), { compilationId: cid, schedule: { everyMinutes: 10, input: {}, ...extra } });
        const plain = await setSchedule({});
        assert.equal(plain.status, 409, plain.bodyText);
        assert.equal(plain.json<Err>().error.code, 'XO_WORKFLOW_REQUIRES_IR_RUNTIME');
        assert.equal((await setSchedule({ certificateId: 'wrc_000000000000000000000000' })).status, 404);
        assert.equal((await setSchedule({ certificateId: cert.certificateId })).status, 200);

        const deps = {
          workspaceStore: new FsWorkspaceStore(new LocalFsBlobStore(workspacesDir)),
          dataConfig: { dataRootDir: dataDir, packageTrustPolicy: PackageTrustPolicy.development() },
          permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
          audit: new AuditService(new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS })),
        };
        const due = new Date(Date.now() + 11 * 60_000);
        assert.deepEqual(await runDueSchedules(deps, due), { started: 1, skipped: 0 });
        const dep = await controls.getDeployment(cid, wf);
        assert.equal(dep?.triggers.schedule?.lastOutcome, 'started on the workflow runtime');
        assert.equal(dep?.triggers.schedule?.startsAs?.id, server.identityId);
        const runs = (await server.request('GET', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/runs`)).json<{
          runs: { runId: string }[];
        }>().runs;
        assert.equal(runs.length, 2, 'the webhook run and the scheduled run');
        // The test server's caller is an API key (a service principal). A schedule set by a person starts as that person.
        await controls.mutate(cid, wf, 'test', new Date().toISOString(), (d) => ({
          ...d,
          triggers: { ...d.triggers, schedule: { ...d.triggers.schedule!, startsAs: { id: server.identityId, kind: 'human' } } },
        }));
        assert.deepEqual(await runDueSchedules(deps, new Date(due.getTime() + 5 * 60_000)), { started: 0, skipped: 0 }, 'not due yet');
        const human = new Date(due.getTime() + 22 * 60_000);
        assert.deepEqual(await runDueSchedules(deps, human), { started: 1, skipped: 0 });
        assert.equal((await controls.getDeployment(cid, wf))?.triggers.schedule?.lastOutcome, 'started on the workflow runtime');

        // The certificate is verified again at every slot: once the knowledge it pinned changes, the slot is skipped, with why.
        const proposal = (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/knowledge-change-sets`)).json<{
          changeSet: { changeSetId: string };
        }>();
        await server.request('POST', `/workspaces/${ws}/knowledge/change-sets/${proposal.changeSet.changeSetId}/approve`, { reason: 'ok' });
        assert.deepEqual(await runDueSchedules(deps, new Date(human.getTime() + 11 * 60_000)), { started: 0, skipped: 1 });
        assert.match((await controls.getDeployment(cid, wf))?.triggers.schedule?.lastOutcome ?? '', /^skipped: .*knowledge state changed/);
      } finally {
        await server.stop();
      }
    });
  });
});
