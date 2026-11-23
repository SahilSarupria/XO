/**
 * S1-0 — Activity's run list: every run in the workspace, across Workflow entities and runs started on a generated definition
 * directly, newest first and paged; read permission only; an outsider sees the same 404 as for an unknown workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';
const GOAL = { text: 'Ship a release', needs: ['Run the full test suite'] };

interface WorkspaceRun {
  runId: string;
  definitionId: string;
  compilationId: string;
  candidateWorkflowId: string;
  workflowId?: string;
  version?: number;
  name: string;
  state: string;
  pendingApprovals: number;
  startedAt: string;
  startedBy?: string;
}

test('workspace runs: entity and definition runs in one list, newest first, paged; outsiders get 404', async () => {
  await withTempDir('xo-api-wsruns-data-', async (dataDir) =>
    withTempDir('xo-api-wsruns-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir, ...NO_OCR }, 'runs-owner');
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        const src = (await server.request('POST', `${base}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{
          sourceId: string;
        }>();
        const cid = (await server.request('POST', `${base}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
          .compilationId;
        const inv = (await server.request('GET', `${base}/compilations/${cid}/capability-inventory`)).json<{
          inventory: { capabilities: { capabilityId: string }[] };
        }>().inventory;
        for (const c of inv.capabilities)
          await server.request('POST', `${base}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);

        const empty = await server.request('GET', `${base}/runs`);
        assert.equal(empty.status, 200, empty.bodyText);
        assert.deepEqual(empty.json<{ runs: unknown[] }>().runs, [], 'nothing run yet: an empty list, not an error');

        // A run started on a generated definition directly (how Studio starts today).
        const gen = await server.request('POST', `${base}/compilations/${cid}/generated-workflows`, { goal: GOAL });
        assert.equal(gen.status, 201, gen.bodyText);
        const definitionId = gen.json<{ definition: { definitionId: string } }>().definition.definitionId;
        const cert = await server.request('POST', `${base}/generated-workflows/${definitionId}/readiness`, {});
        assert.equal(cert.status, 201, cert.bodyText);
        const certificateId = cert.json<{ certificateId: string }>().certificateId;
        const direct = await server.request('POST', `${base}/generated-workflows/${definitionId}/runs`, { input: {}, certificateId });
        assert.equal(direct.status, 201, direct.bodyText);
        const directRun = direct.json<{ runId: string }>().runId;

        // A run started on a Workflow entity, renamed so its name is the entity's, not the definition's.
        const created = await server.request('POST', `${base}/workflow-entities`, {
          compilationId: cid,
          goal: GOAL,
          name: 'Weekly release',
        });
        assert.equal(created.status, 201, created.bodyText);
        const workflowId = created.json<{ workflow: { workflowId: string } }>().workflow.workflowId;
        assert.equal((await server.request('POST', `${base}/workflow-entities/${workflowId}/readiness`, {})).status, 201);
        const entity = await server.request('POST', `${base}/workflow-entities/${workflowId}/runs`, { input: {} });
        assert.equal(entity.status, 201, entity.bodyText);
        const entityRun = entity.json<{ runId: string }>().runId;

        const all = (await server.request('GET', `${base}/runs`)).json<{ runs: WorkspaceRun[]; nextCursor?: string }>();
        assert.equal(all.runs.length, 2);
        assert.equal(all.nextCursor, undefined);
        const byId = new Map(all.runs.map((r) => [r.runId, r]));
        const e = byId.get(entityRun)!;
        assert.equal(e.workflowId, workflowId);
        assert.equal(e.version, 1);
        assert.equal(e.name, 'Weekly release');
        assert.equal(e.state, 'waiting');
        assert.equal(e.pendingApprovals, 1);
        const d = byId.get(directRun)!;
        assert.equal(d.workflowId, undefined, 'a definition run belongs to no workflow');
        assert.equal(d.version, undefined);
        assert.equal(d.definitionId, definitionId);
        assert.equal(d.compilationId, cid, 'a run names the compilation its definition came from');
        assert.ok(d.candidateWorkflowId.length > 0);
        assert.ok(d.name.length > 0, 'a definition run carries the definition name');
        assert.ok(all.runs[0]!.startedAt >= all.runs[1]!.startedAt, 'newest first');

        const first = (await server.request('GET', `${base}/runs?limit=1`)).json<{ runs: WorkspaceRun[]; nextCursor?: string }>();
        assert.equal(first.runs.length, 1);
        assert.ok(first.nextCursor !== undefined);
        const second = (await server.request('GET', `${base}/runs?limit=1&cursor=${first.nextCursor}`)).json<{
          runs: WorkspaceRun[];
          nextCursor?: string;
        }>();
        assert.equal(second.runs.length, 1);
        assert.equal(second.nextCursor, undefined);
        assert.notEqual(first.runs[0]!.runId, second.runs[0]!.runId, 'pages do not repeat a run');

        assert.equal((await server.request('GET', `${base}/runs?limit=0`)).status, 400);
        const outsider = TestServer.authHeader((await server.issueAdditionalIdentity('outsider')).apiKey);
        assert.equal((await server.request('GET', `${base}/runs`, undefined, outsider)).status, 404);
      } finally {
        await server.stop();
      }
    }),
  );
});
