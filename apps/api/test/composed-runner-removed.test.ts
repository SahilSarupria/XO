/**
 * ADR 0052 decision 6 — the composed-workflow runner's code is removed. Its routes answer 410 naming the replacement, historic executions
 * stay readable, a stored practice mode reads as draft, triggers without a certificate are refused or skipped, and an upgrade refuses
 * while composed executions are unfinished unless the operator accepts it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import { PackageTrustPolicy } from '@xo/package-sdk';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { EI_AUDIT_EXTENSION_SCHEMAS } from '@xo/connect';
import { NonProductionAuditSink } from '@xo/audit';
import { countUnfinishedComposedExecutions } from '@xo/instance';
import { AuditService } from '../src/audit/audit-service.js';
import { FsControlsStore } from '../src/workflow-controls/fs-controls-store.js';
import { runDueSchedules } from '../src/workflow-controls/scheduler.js';
import { FsWorkspaceStore } from '../src/workspace/fs-workspace-store.js';
import { workspaceStateStore } from '../src/workspace/workspace-context.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';
type Err = { error: { code: string; context?: { reason?: string; replacement?: string } } };

async function setup(server: TestServer, dataDir: string) {
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
  const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{
    inventory: { capabilities: { capabilityId: string }[] };
  }>().inventory;
  for (const c of inv.capabilities)
    await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
  const cert = (await server.request('POST', `/workspaces/${ws}/generated-workflows/${gen.definitionId}/readiness`, {})).json<{
    certificateId: string;
  }>();
  const controls = new FsControlsStore(workspaceStateStore(workspace, { dataRootDir: dataDir }), ws);
  return { workspace, ws, cid, gen, wf: gen.candidateWorkflowId, cert, controls };
}

test('ADR 0052: every removed composed route answers 410 naming its replacement', async () => {
  await withTempDir('xo-api-removed-', async (dataDir) => {
    await withTempDir('xo-api-removed-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, ...NO_OCR });
      try {
        const { ws, cid, gen, wf } = await setup(server, dataDir);
        const removed = [
          `/workspaces/${ws}/workflows/${wf}/executions`,
          `/workspaces/${ws}/workflow-executions/wfx_00000000000000000000000000000000/resume`,
          `/workspaces/${ws}/workflow-definitions/${gen.definitionId}/run`,
          `/workspaces/${ws}/workflow-controls/workflows/${wf}/shadow-reviews`,
        ];
        for (const path of removed) {
          const r = await server.request('POST', path, { compilationId: cid, input: {} });
          assert.equal(r.status, 410, `${path}: ${r.bodyText}`);
          assert.equal(r.json<Err>().error.code, 'XO_COMPOSED_RUNNER_REMOVED');
          assert.equal(typeof r.json<Err>().error.context?.replacement, 'string');
          assert.ok(!r.bodyText.includes(cid), 'the 410 does not echo the request');
        }
        // The stub keeps authentication and workspace membership: another workspace is 404, not 410.
        const other = await server.request('POST', `/workspaces/ws_other/workflows/${wf}/executions`, {});
        assert.notEqual(other.status, 410);
      } finally {
        await server.stop();
      }
    });
  });
});

test('ADR 0052: historic composed executions stay readable', async () => {
  await withTempDir('xo-api-removed-', async (dataDir) => {
    await withTempDir('xo-api-removed-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, ...NO_OCR });
      try {
        const { ws, cid, wf } = await setup(server, dataDir);
        const id = 'wfx_11111111111111111111111111111111';
        const dir = join(dataDir, ws, 'workflow-executions', id);
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, 'metadata.json'),
          JSON.stringify({
            workflowExecutionId: id,
            workspaceId: ws,
            identityId: server.identityId,
            initiator: { id: server.identityId, kind: 'human' },
            compilationId: cid,
            workflowId: wf,
            workflowName: 'Ship a release',
            revision: 1,
            status: 'succeeded',
            steps: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        );
        const list = await server.request('GET', `/workspaces/${ws}/workflow-executions`);
        assert.equal(list.status, 200, list.bodyText);
        assert.equal(list.json<{ workflowExecutions: unknown[] }>().workflowExecutions.length, 1);
        assert.equal((await server.request('GET', `/workspaces/${ws}/workflow-executions/${id}`)).status, 200);
      } finally {
        await server.stop();
      }
    });
  });
});

test('ADR 0052: a stored practice mode reads as draft', async () => {
  await withTempDir('xo-api-removed-', async (dataDir) => {
    await withTempDir('xo-api-removed-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, ...NO_OCR });
      try {
        const { ws, cid, wf, controls } = await setup(server, dataDir);
        await controls.mutate(cid, wf, 'test', new Date().toISOString(), (d) => ({ ...d, mode: 'paused', modeBeforePause: 'live' }));
        // Write the legacy values straight to the store, the way an older instance left them.
        await controls.mutate(
          cid,
          wf,
          'test',
          new Date().toISOString(),
          (d) => ({ ...d, mode: 'shadow', modeBeforePause: 'shadow' }) as never,
        );
        const dep = await controls.getDeployment(cid, wf);
        assert.equal(dep?.mode, 'draft');
        assert.notEqual(dep?.modeBeforePause, 'shadow');
        const view = await server.request('GET', `/workspaces/${ws}/workflow-controls/workflows/${wf}?compilationId=${cid}`);
        assert.ok(!view.bodyText.includes('"shadow"'), 'the controls view never reports practice mode');
        const set = await server.request('POST', `/workspaces/${ws}/workflow-controls/workflows/${wf}/mode`, {
          compilationId: cid,
          mode: 'shadow',
        });
        assert.equal(set.status, 400, set.bodyText);
      } finally {
        await server.stop();
      }
    });
  });
});

test('ADR 0052: a schedule without a certificate is skipped, a webhook without one is refused, in development too', async () => {
  await withTempDir('xo-api-removed-', async (dataDir) => {
    await withTempDir('xo-api-removed-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, ...NO_OCR });
      try {
        // No `requireReadinessCertificate` setting here: the rule holds in every workspace.
        const { ws, cid, wf, cert, controls } = await setup(server, dataDir);
        const ctl = `/workspaces/${ws}/workflow-controls/workflows/${wf}/triggers`;
        assert.equal(
          (
            await server.request('PUT', ctl, {
              compilationId: cid,
              schedule: { everyMinutes: 10, input: {}, certificateId: cert.certificateId },
            })
          ).status,
          200,
        );
        assert.equal((await server.request('PUT', ctl, { compilationId: cid, webhook: true })).status, 200);
        await controls.mutate(cid, wf, 'test', new Date().toISOString(), (d) => {
          const { certificateId: _c, ...schedule } = d.triggers.schedule as Record<string, unknown>;
          return { ...d, mode: 'live', triggers: { ...d.triggers, schedule } } as never;
        });
        const hook = await server.request('POST', `/workspaces/${ws}/workflows/${wf}/webhook`, { compilationId: cid, input: {} });
        assert.equal(hook.status, 409, hook.bodyText);
        assert.equal(hook.json<Err>().error.code, 'XO_WORKFLOW_REQUIRES_IR_RUNTIME');
        const deps = {
          workspaceStore: new FsWorkspaceStore(new LocalFsBlobStore(workspacesDir)),
          dataConfig: { dataRootDir: dataDir, packageTrustPolicy: PackageTrustPolicy.development() },
          permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
          audit: new AuditService(new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS })),
        };
        const result = await runDueSchedules(deps, new Date(Date.now() + 11 * 60_000));
        assert.deepEqual(result, { started: 0, skipped: 1 });
        assert.equal(
          (await controls.getDeployment(cid, wf))?.triggers.schedule?.lastOutcome,
          'skipped: this schedule needs a readiness certificate',
        );
      } finally {
        await server.stop();
      }
    });
  });
});

test('ADR 0052: upgrade refuses while composed executions are unfinished unless the operator accepts it', async () => {
  await withTempDir('xo-api-removed-', async (dir) => {
    const put = async (ws: string, id: string, status: string) => {
      const d = join(dir, ws, 'workflow-executions', id);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, 'metadata.json'), JSON.stringify({ status }));
    };
    assert.deepEqual(await countUnfinishedComposedExecutions(dir), {}, 'nothing stored, nothing unfinished');
    await put('ws_a', 'wfx_1', 'succeeded');
    await put('ws_a', 'wfx_2', 'waiting_for_human');
    await put('ws_a', 'wfx_3', 'running');
    await put('ws_b', 'wfx_4', 'failed');
    await put('ws_b', 'wfx_5', 'rejected');
    assert.deepEqual(await countUnfinishedComposedExecutions(dir), { ws_a: 2 }, 'ids and counts only, terminal ones not counted');
    await mkdir(join(dir, 'ws_c', 'workflow-executions', 'wfx_6'), { recursive: true });
    assert.deepEqual((await countUnfinishedComposedExecutions(dir))['ws_c'], 1, 'an unreadable record counts as unfinished');
  });
});
