/**
 * UW-7 (ADR 0011 decision 4, ADR 0033) — parity between the two runners for the same compiled workflow: the composed-workflow
 * runner (P0.8) and the canonical Workflow IR runtime. A path moves to the canonical engine only once tests like this pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestServer, withTempDir } from './test-helpers.js';

const NO_OCR = { extraction: { pageTiers: [], ocr: { mode: 'off' as const } } };
const PROCEDURE =
  '# Release procedure\n\n| Step | What to do | Done when | Owner |\n|---|---|---|---|\n| 1 | Pull the latest code from the main branch. | The working copy matches main. | Release engineer |\n| 2 | Run the full test suite. | All tests pass. | Release engineer |\n| 3 | Tag the release. | The tag is pushed. | Release engineer |\n';

interface Composed {
  workflowExecutionId: string;
  status: string;
  steps: { status: string; executionId?: string; capabilityName: string }[];
}
interface IrRun {
  runId: string;
  state: string;
  pendingApprovals: { approvalId: string; summary: string }[];
}

async function setup(server: TestServer) {
  const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>().workspaceId;
  const base = `/workspaces/${ws}`;
  const src = (await server.request('POST', `${base}/sources?filename=release.md`, Buffer.from(PROCEDURE))).json<{ sourceId: string }>();
  const cid = (await server.request('POST', `${base}/sources/${src.sourceId}/compile`)).json<{ compilationId: string }>().compilationId;
  const inv = (await server.request('GET', `${base}/compilations/${cid}/capability-inventory`)).json<{
    inventory: { capabilities: { capabilityId: string }[] };
  }>().inventory;
  for (const c of inv.capabilities)
    await server.request('POST', `${base}/compilations/${cid}/capabilities/${encodeURIComponent(c.capabilityId)}/approve`);
  const def = (
    await server.request('POST', `${base}/compilations/${cid}/generated-workflows`, {
      goal: { text: 'Ship a release', needs: ['Tag the release'] },
    })
  ).json<{ definition: { definitionId: string; candidateWorkflowId: string } }>().definition;
  const cert = (await server.request('POST', `${base}/generated-workflows/${def.definitionId}/readiness`, {})).json<{
    certificateId: string;
  }>();
  return { base, cid, def, certId: cert.certificateId };
}

/** Composed runner: each human step in turn, decided with `decisions[i]`, until it stops waiting. */
async function composed(server: TestServer, s: Awaited<ReturnType<typeof setup>>, decisions: readonly ('approve' | 'reject')[]) {
  let wf = (
    await server.request('POST', `${s.base}/workflows/${encodeURIComponent(s.def.candidateWorkflowId)}/executions`, {
      compilationId: s.cid,
    })
  ).json<Composed>();
  const asked: string[] = [];
  for (const d of decisions) {
    const waiting = wf.steps.find((x) => x.status === 'waiting_for_human');
    if (wf.status !== 'waiting_for_human' || waiting === undefined) break;
    asked.push(waiting.capabilityName);
    const r = await server.request('POST', `${s.base}/workflow-executions/${wf.workflowExecutionId}/resume`, {
      decision: d,
      expectedStepExecutionId: waiting.executionId,
    });
    assert.equal(r.status, 200, r.bodyText);
    wf = r.json<Composed>();
  }
  return { asked, final: wf.status };
}

/** Workflow IR runtime: each approval in turn, decided with `decisions[i]`, until none is pending. */
async function ir(server: TestServer, s: Awaited<ReturnType<typeof setup>>, decisions: readonly ('approve' | 'reject')[]) {
  const runs = `${s.base}/generated-workflows/${s.def.definitionId}/runs`;
  let run = (await server.request('POST', runs, { input: {}, certificateId: s.certId })).json<IrRun>();
  const asked: string[] = [];
  for (const d of decisions) {
    const p = run.pendingApprovals[0];
    if (p === undefined) break;
    asked.push(p.summary);
    const r = await server.request('POST', `${runs}/${run.runId}/approvals/${p.approvalId}`, { action: d });
    assert.equal(r.status, 200, r.bodyText);
    run = r.json<IrRun>();
  }
  return { asked, final: run.state };
}

test('the same release procedure: both runners ask for the same human steps, in the same order, and both finish', async () => {
  await withTempDir('xo-parity-', async (dir) => {
    const server = await TestServer.start({ workspaceDataDir: dir, ...NO_OCR });
    try {
      const s = await setup(server);
      const a = await composed(server, s, ['approve', 'approve', 'approve']);
      const b = await ir(server, s, ['approve', 'approve', 'approve']);
      assert.deepEqual(a.asked, ['Pull the latest code', 'Run the full test suite', 'Tag the release']);
      assert.equal(b.asked.length, 3);
      a.asked.forEach((name, i) => assert.match(b.asked[i]!, new RegExp(name), `step ${i + 1} is the same human task`));
      assert.equal(a.final, 'succeeded');
      assert.equal(b.final, 'completed');
    } finally {
      await server.stop();
    }
  });
});

test('a person rejects the second step: neither runner asks for the third, and neither reports success', async () => {
  await withTempDir('xo-parity-r-', async (dir) => {
    const server = await TestServer.start({ workspaceDataDir: dir, ...NO_OCR });
    try {
      const s = await setup(server);
      const a = await composed(server, s, ['approve', 'reject', 'approve']);
      const b = await ir(server, s, ['approve', 'reject', 'approve']);
      assert.equal(a.asked.length, 2);
      assert.equal(b.asked.length, 2);
      // The composed runner ends `rejected`; the canonical engine stops at the task's not-done escalation and hands the case
      // back to a person (ADR 0033). Before UW-7 the IR run skipped the rest and ended `completed`.
      assert.equal(a.final, 'rejected');
      assert.equal(b.final, 'escalated');
    } finally {
      await server.stop();
    }
  });
});
