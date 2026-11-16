/** PX-6 — goal → scope selection → Workflow IR, persisted with a digest that survives regeneration. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkflowComponent } from '@xo/workflow-ir';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n\n# Refunds\n\nIf the refund amount exceeds 500, the refund must be denied.\n';

interface Definition {
  definitionId: string;
  candidateWorkflowId: string;
  lowered: { complete: boolean; definitionDigest: string; component: unknown; issues: unknown[] };
}

test('a goal selects the workflow and lowers it to valid Workflow IR; regeneration keeps the digest; a vague goal asks', async () => {
  await withTempDir('xo-api-wfd-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=ops.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const url = `/workspaces/${ws}/compilations/${cid}/generated-workflows`;
      const goal = { text: 'Ship a release', needs: ['Run the full test suite'] };
      const first = await server.request('POST', url, { goal });
      assert.equal(first.status, 201, first.bodyText);
      const def = first.json<{ definition: Definition; selection: { status: string; rationale: string } }>();
      assert.equal(def.selection.status, 'selected');
      assert.match(def.selection.rationale, /Run the full test suite/);
      assert.equal(def.definition.lowered.complete, true, JSON.stringify(def.definition.lowered.issues));
      assert.equal(validateWorkflowComponent(def.definition.lowered.component).valid, true);

      const again = (await server.request('POST', url, { goal })).json<{ definition: Definition }>().definition;
      assert.equal(again.definitionId, def.definition.definitionId);
      assert.equal(again.lowered.definitionDigest, def.definition.lowered.definitionDigest);

      const vague = (await server.request('POST', url, { goal: { text: 'organise the company picnic' } })).json<{
        definition: null;
        selection: { status: string };
      }>();
      assert.equal(vague.definition, null);
      assert.equal(vague.selection.status, 'no_match');
      assert.equal((await server.request('POST', url, { goal: { text: '' } })).status, 400);

      const listedRes = await server.request('GET', `/workspaces/${ws}/generated-workflows`);
      const listed = listedRes.json<{ definitions: Definition[] }>().definitions;
      assert.equal(listed.length, 1);
      const got = await server.request('GET', `/workspaces/${ws}/generated-workflows/${def.definition.definitionId}`);
      assert.equal(got.status, 200);
      assert.equal((await server.request('GET', `/workspaces/${ws}/generated-workflows/gwf_000000000000000000000000`)).status, 404);
    } finally {
      await server.stop();
    }
  });
});
