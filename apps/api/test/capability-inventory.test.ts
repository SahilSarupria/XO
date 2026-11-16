/**
 * PX-5 — the capability inventory over HTTP: procedure steps bind as human tasks under the same rule as prose actions,
 * authorization is the approval verdict, and gaps are reported for unmet needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const TEXT =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

interface Report {
  capabilityId: string;
  name: string;
  status: string;
  humanTask?: { origin: string; actorRole: { value: string } };
  readiness: { bound: { strategy?: string }; authorized: { value: string }; runnable: boolean };
}

test('procedure steps are human tasks; approval makes one runnable; unmet needs are gaps', async () => {
  await withTempDir('xo-api-inventory-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(TEXT))).json<{
        sourceId: string;
      }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>()
        .compilationId;
      const url = `/workspaces/${ws}/compilations/${cid}/capability-inventory?need=${encodeURIComponent('Run the full test suite')}&need=${encodeURIComponent('Deploy to production')}`;
      const first = await server.request('GET', url);
      assert.equal(first.status, 200, first.bodyText);
      const inv = first.json<{ inventory: { capabilities: Report[]; gaps: { need: string }[]; digest: string } }>().inventory;
      const steps = inv.capabilities.filter((c) => c.humanTask?.origin === 'procedure-step');
      assert.equal(steps.length, 2, JSON.stringify(inv.capabilities.map((c) => c.name)));
      for (const s of steps) {
        assert.equal(s.readiness.bound.strategy, 'human_in_the_loop');
        assert.equal(s.humanTask!.actorRole.value, 'Release engineer');
        assert.equal(s.readiness.authorized.value, 'no');
        assert.equal(s.readiness.runnable, false);
      }
      assert.deepEqual(
        inv.gaps.map((g) => g.need),
        ['Deploy to production'],
      );

      const approve = await server.request(
        'POST',
        `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(steps[0]!.capabilityId)}/approve`,
      );
      assert.equal(approve.status, 200, approve.bodyText);
      const after = (await server.request('GET', url)).json<{ inventory: { capabilities: Report[] } }>().inventory;
      const approved = after.capabilities.find((c) => c.capabilityId === steps[0]!.capabilityId)!;
      assert.equal(approved.status, 'accepted');
      assert.equal(approved.readiness.runnable, true);

      const caps = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capabilities`)).json<{
        capabilities: { capabilityId: string; status: string; understanding?: string }[];
      }>().capabilities;
      for (const s of steps) {
        const p = caps.find((c) => c.capabilityId === s.capabilityId)!;
        assert.equal(p.status, 'resolved');
        assert.equal(p.understanding, 'manual_step', 'a bound manual step still says it is one');
      }
    } finally {
      await server.stop();
    }
  });
});
