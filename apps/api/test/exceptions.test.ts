/** UW-15 (ADR 0044), UAC-36: per-workflow exception rate and an exceptions-only queue. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';
import { exceptionReport, type JournalLike } from '../src/workflow-controls/exceptions.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n';

const e = (seq: number, ts: string, type: string, data: Record<string, unknown> = {}): JournalLike => ({ seq, ts, type, data });

test('rates over 30 days: runs and items needing a person; the queue holds only what is still open', () => {
  const now = new Date('2026-11-20T00:00:00Z');
  const clean = { runId: 'r1', entries: [e(1, '2026-11-10T00:00:00Z', 'run_started', { fanout: { count: 10 } }), e(2, '2026-11-10T00:01:00Z', 'run_finished', { state: 'completed' })] };
  const asked = {
    runId: 'r2',
    entries: [
      e(1, '2026-11-11T00:00:00Z', 'run_started', { fanout: { count: 10 } }),
      e(2, '2026-11-11T00:01:00Z', 'approval_requested', { step: 'check#3' }),
      e(3, '2026-11-11T00:02:00Z', 'approval_requested', { step: 'check#7' }),
      e(4, '2026-11-11T01:00:00Z', 'approval_decided', { step: 'check#3' }),
    ],
  };
  const escalated = { runId: 'r3', entries: [e(1, '2026-11-12T00:00:00Z', 'run_started', {}), e(2, '2026-11-12T00:01:00Z', 'escalation', { step: 'send' }), e(3, '2026-11-12T00:01:01Z', 'run_finished', { state: 'escalated' })] };
  const old = { runId: 'r4', entries: [e(1, '2026-09-01T00:00:00Z', 'run_started', {}), e(2, '2026-09-01T00:01:00Z', 'approval_requested', { step: 'x' })] };
  const r = exceptionReport([clean, asked, escalated, old], now);
  assert.deepEqual(r.stats, { windowDays: 30, runs: 3, runsNeedingPerson: 2, runRate: 0.6667, items: 20, itemsNeedingPerson: 2, itemRate: 0.1 });
  assert.deepEqual(r.queue.map((q) => [q.runId, q.kind, q.step]), [['r2', 'approval', 'check#7'], ['r3', 'escalation', 'send']]);
  assert.deepEqual(exceptionReport([], now).stats.runRate, null);
});

test('over HTTP: a run waiting for a person is an exception and is queued; once decided it leaves the queue but still counts', async () => {
  await withTempDir('xo-api-exc-', async (dataDir) => {
    const server = await TestServer.start({ workspaceDataDir: dataDir, ...NO_OCR });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
      const src = (await server.request('POST', `/workspaces/${ws}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{ sourceId: string }>();
      const cid = (await server.request('POST', `/workspaces/${ws}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>().compilationId;
      const inv = (await server.request('GET', `/workspaces/${ws}/compilations/${cid}/capability-inventory`)).json<{ inventory: { capabilities: { capabilityId: string }[] } }>().inventory;
      for (const c of inv.capabilities) await server.request('POST', `/workspaces/${ws}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
      const def = (await server.request('POST', `/workspaces/${ws}/compilations/${cid}/generated-workflows`, { goal: { text: 'Ship a release', needs: ['Run the full test suite'] } })).json<{ definition: { definitionId: string } }>().definition;
      const base = `/workspaces/${ws}/generated-workflows/${def.definitionId}`;
      const empty = (await server.request('GET', `${base}/exceptions`)).json<{ stats: { runs: number; runRate: number | null }; queue: unknown[] }>();
      assert.deepEqual([empty.stats.runs, empty.stats.runRate, empty.queue.length], [0, null, 0]);
      const cert = (await server.request('POST', `${base}/readiness`, {})).json<{ certificateId: string }>();
      const run = (await server.request('POST', `${base}/runs`, { input: {}, certificateId: cert.certificateId })).json<{ runId: string; pendingApprovals: { approvalId: string }[] }>();
      const waiting = (await server.request('GET', `${base}/exceptions`)).json<{ stats: { runs: number; runsNeedingPerson: number; runRate: number }; queue: { kind: string; runId: string }[] }>();
      assert.deepEqual([waiting.stats.runs, waiting.stats.runsNeedingPerson, waiting.stats.runRate], [1, 1, 1]);
      assert.deepEqual(waiting.queue.map((q) => [q.kind, q.runId]), [['approval', run.runId]]);
      let cur = run;
      for (let i = 0; i < 2; i++) cur = (await server.request('POST', `${base}/runs/${run.runId}/approvals/${cur.pendingApprovals[0]!.approvalId}`, { action: 'approve' })).json();
      const done = (await server.request('GET', `${base}/exceptions`)).json<{ stats: { runsNeedingPerson: number }; queue: unknown[] }>();
      assert.deepEqual([done.stats.runsNeedingPerson, done.queue.length], [1, 0]);
    } finally {
      await server.stop();
    }
  });
});
