/** UW-15 (ADR 0044): the same goal over the same schema and catalogue reuses the compiled definition; a change composes afresh. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n| 3 | Publish the release notes. | The notes are online. | Release engineer |\n';

test('a repeated goal reuses the definition; a different goal, or a changed binding, composes afresh', async () => {
  await withTempDir('xo-api-reuse-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{ sourceId: string }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>().compilationId;
      const url = `/workspaces/${ws}/compilations/${cid}/generated-workflows`;
      type R = { definition: { definitionId: string; createdAt: string }; reused: boolean };
      const goal = { text: 'Ship a release', needs: ['Run the full test suite'] };
      const first = (await server.request('POST', url, { goal })).json<R>();
      assert.equal(first.reused, false);
      const again = (await server.request('POST', url, { goal })).json<R>();
      assert.equal(again.reused, true);
      assert.equal(again.definition.definitionId, first.definition.definitionId);
      assert.equal(again.definition.createdAt, first.definition.createdAt, 'the stored definition itself, not a new one');
      // Same goal, said with a different stated need: a different goal, composed afresh.
      const other = (await server.request('POST', url, { goal: { text: 'Ship a release', needs: ['Publish the release notes'] } })).json<R>();
      assert.equal(other.reused, false);
      // A change to the connector bindings is part of the key.
      const put = await server.request('PUT', `/workspaces/${ws}/connector-bindings`, { bindings: [{ capability: 'pull', connector: 'git', kind: 'http', operation: 'pull', sideEffect: 'read', adapter: 'none' }] });
      assert.equal(put.status, 200, put.bodyText);
      assert.equal((await server.request('POST', url, { goal })).json<R>().reused, false);
    } finally {
      await server.stop();
    }
  });
});
