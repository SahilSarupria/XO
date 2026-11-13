/**
 * UW-3b (F) — the capability projection carries what the compiler understood, and understanding never unlocks running.
 * TaskTest.pdf's 8 workflow steps are manual steps: understood (`understanding: 'manual_step'`), still unresolved, and a
 * test run of one is blocked exactly as for any capability that does not bind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TestServer, withTempDir } from './test-helpers.js';

const PDF = fileURLToPath(new URL('../../../examples/vertical-test/TaskTest.pdf', import.meta.url));

interface Cap {
  capabilityId: string;
  name: string;
  status: string;
  understanding?: string;
}

test('a procedure step is projected as an understood manual step, stays unresolved, and cannot be test-run', async () => {
  await withTempDir('xo-api-data-', async (dataDir) =>
    withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
        const base = `/workspaces/${ws}`;
        const src = (await server.request('POST', `${base}/sources?filename=TaskTest.pdf`, await readFile(PDF))).json<{
          sourceId: string;
        }>();
        const comp = (await server.request('POST', `${base}/sources/${src.sourceId}/compile`)).json<{
          compilationId: string;
          status: string;
        }>();
        assert.equal(comp.status, 'succeeded');
        const caps = (await server.request('GET', `${base}/compilations/${comp.compilationId}/capabilities`)).json<{
          capabilities: Cap[];
        }>().capabilities;
        assert.deepEqual(caps.map((c) => c.name).sort(), ['Build', 'Deliver', 'Plan', 'Reflect', 'Review', 'Set up', 'Test', 'Understand']);
        for (const c of caps) {
          assert.equal(c.understanding, 'manual_step', c.name);
          assert.notEqual(c.status, 'resolved', `${c.name}: understanding is not resolution`);
        }
        const review = caps.find((c) => c.name === 'Review')!;
        const preview = (
          await server.request('POST', `${base}/compilations/${comp.compilationId}/capabilities/${review.capabilityId}/preview`, {
            input: {},
          })
        ).json<{ testRunAllowed: boolean }>();
        assert.equal(preview.testRunAllowed, false);
      } finally {
        await server.stop();
      }
    }),
  );
});
