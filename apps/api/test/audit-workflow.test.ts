import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditError, ErrorCode } from '@xo/errors';
import { NonProductionAuditSink, type AppendResult, type AuditEvent, type AuditEventDraft, type AuditSink } from '@xo/audit';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';

// P1.0 M4 — workflow start / HITL / resume / human-task resolve audit evidence and failure semantics.

class FlakySink implements AuditSink {
  readonly mode = 'non-production' as const;
  readonly inner = new NonProductionAuditSink();
  readonly appended: AuditEventDraft[] = [];
  failTypes = new Set<string>();
  async append(d: AuditEventDraft): Promise<AppendResult> {
    this.appended.push(d);
    if (this.failTypes.has(d.type)) return { ok: false, error: new AuditError(ErrorCode.AUDIT_UNAVAILABLE, 'down'), indeterminate: false };
    return this.inner.append(d);
  }
  events = (): readonly AuditEvent[] => this.inner.events();
}

async function withEnv(fn: (e: { server: TestServer; sink: FlakySink; w: string; compilationId: string }) => Promise<void>): Promise<void> {
  await withTempDir('xo-audit-wf-', async (dataDir) => {
    const sink = new FlakySink();
    const server = await TestServer.start({ workspaceDataDir: dataDir, auditSink: sink });
    try {
      const ws = (await server.request('POST', '/workspaces', {})).json<{ workspaceId: string }>();
      const { compilationId } = await storeFixtureCompilation(ws as never, dataDir);
      await fn({ server, sink, w: ws.workspaceId, compilationId });
    } finally {
      await server.stop();
    }
  });
}
type E = Parameters<Parameters<typeof withEnv>[0]>[0];
const approveAll = async (e: E): Promise<void> => {
  for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC])
    assert.ok(
      [200, 201].includes(
        (await e.server.request('POST', `/workspaces/${e.w}/compilations/${e.compilationId}/capabilities/${id}/approve`)).status,
      ),
    );
};
async function start(e: E) {
  const wfs = (await e.server.request('GET', `/workspaces/${e.w}/workflows`)).json<{
    workflows: { workflowId: string; steps: { capabilityId: string }[] }[];
  }>().workflows;
  const wf = wfs.find((x) => x.steps[0]?.capabilityId === IDS.hitlA);
  assert.ok(wf);
  return e.server.request('POST', `/workspaces/${e.w}/workflows/${wf.workflowId}/executions`, {
    compilationId: e.compilationId,
    input: { screening_score: 90, settlement_amount: 800 },
  });
}

test('workflow start: attempt recorded BEFORE the run; step + workflow outcomes recorded from the persisted record', async () => {
  await withEnv(async (e) => {
    await approveAll(e);
    const res = await start(e);
    assert.equal(res.status, 201);
    const rec = res.json<{ workflowExecutionId: string; status: string; auditFinalization?: unknown }>();
    assert.equal(rec.status, 'waiting_for_human');
    assert.equal(rec.auditFinalization, undefined);
    const wf = e.sink.events().filter((x) => x.type.startsWith('workflow.') && x.action === 'start.workflow');
    assert.equal(wf[0]?.type, 'workflow.attempted');
    assert.equal(wf[0]?.outcome, 'attempted');
    assert.ok(
      wf.some((x) => x.type === 'workflow.step.completed'),
      'step A succeeded',
    );
    const last = wf[wf.length - 1] as AuditEvent;
    assert.equal(last.type, 'workflow.waiting_for_human');
    assert.equal(last.executionId, rec.workflowExecutionId);
    assert.equal(new Set(wf.map((x) => x.correlationId)).size, 1);
  });
});

test('workflow start: audit outage BEFORE blocks it (503, no workflow execution, no step executed)', async () => {
  await withEnv(async (e) => {
    await approveAll(e);
    e.sink.failTypes.add('workflow.attempted');
    const res = await start(e);
    assert.equal(res.status, 503);
    e.sink.failTypes.clear();
    assert.equal(
      (await e.server.request('GET', `/workspaces/${e.w}/workflow-executions`)).json<{ workflowExecutions: unknown[] }>().workflowExecutions
        .length,
      0,
    );
    assert.equal((await e.server.request('GET', `/workspaces/${e.w}/executions`)).json<{ executions: unknown[] }>().executions.length, 0);
  });
});

test('workflow start: completion-evidence outage AFTER the run keeps the real outcome, flags finalization, never re-runs', async () => {
  await withEnv(async (e) => {
    await approveAll(e);
    e.sink.failTypes.add('workflow.waiting_for_human');
    const res = await start(e);
    assert.equal(res.status, 201);
    const body = res.json<{
      workflowExecutionId: string;
      status: string;
      auditFinalization: { status: string; executionId: string; correlationId: string };
    }>();
    assert.equal(body.status, 'waiting_for_human');
    assert.equal(body.auditFinalization.status, 'failed');
    assert.equal(body.auditFinalization.executionId, body.workflowExecutionId);
    e.sink.failTypes.clear();
    assert.equal(
      (await e.server.request('GET', `/workspaces/${e.w}/workflow-executions`)).json<{ workflowExecutions: unknown[] }>().workflowExecutions
        .length,
      1,
    );
    assert.equal(
      (await e.server.request('GET', `/workspaces/${e.w}/executions`)).json<{ executions: unknown[] }>().executions.length,
      2,
      'A and B executed exactly once each',
    );
  });
});

test('HITL resume: attempt recorded first; resume to completion records step outcomes and workflow.completed; failure of the precondition blocks the resume', async () => {
  await withEnv(async (e) => {
    await approveAll(e);
    const wf = (await start(e)).json<{ workflowExecutionId: string; steps: { executionId?: string }[] }>();
    const bId = wf.steps[1]?.executionId as string;
    const path = `/workspaces/${e.w}/workflow-executions/${wf.workflowExecutionId}/resume`;

    e.sink.failTypes.add('workflow.attempted');
    const blocked = await e.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: bId });
    assert.equal(blocked.status, 503);
    e.sink.failTypes.clear();
    const still = (await e.server.request('GET', `/workspaces/${e.w}/workflow-executions/${wf.workflowExecutionId}`)).json<{
      status: string;
    }>();
    assert.equal(still.status, 'waiting_for_human', 'blocked resume changed nothing');

    const before = e.sink.events().length;
    const ok = await e.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: bId });
    assert.equal(ok.status, 200);
    const fresh = e.sink
      .events()
      .slice(before)
      .filter((x) => x.action === 'resume.workflow');
    assert.equal(fresh[0]?.type, 'workflow.attempted');
    assert.equal(fresh[0]?.metadata?.['decision'], 'approve');
    assert.equal(fresh[0]?.actor.id, e.server.identityId);
    assert.equal((fresh[fresh.length - 1] as AuditEvent).type, 'workflow.completed');
  });
});

test('standalone human-task resolve: attempt precondition; resolved event after; outage before blocks; outage after flags without redo', async () => {
  await withEnv(async (e) => {
    await approveAll(e);
    const wf = (await start(e)).json<{ steps: { executionId?: string }[] }>();
    const bId = wf.steps[1]?.executionId as string;
    const path = `/workspaces/${e.w}/executions/${bId}/resolve`;

    e.sink.failTypes.add('humantask.attempted');
    assert.equal((await e.server.request('POST', path, { decision: 'approve' })).status, 503);
    e.sink.failTypes.clear();
    const stillPending = (await e.server.request('GET', `/workspaces/${e.w}/human-tasks/${bId}`)).json<{
      humanTask?: { status: string };
    }>();
    assert.equal(stillPending.humanTask?.status, 'pending');

    e.sink.failTypes.add('humantask.resolved');
    const res = await e.server.request('POST', path, { decision: 'approve' });
    assert.equal(res.status, 200, 'the decision really happened');
    assert.equal(res.json<{ auditFinalization: { status: string; executionId: string } }>().auditFinalization.status, 'failed');
    e.sink.failTypes.clear();
    const dup = await e.server.request('POST', path, { decision: 'approve' });
    assert.equal(dup.status, 409, 'not re-applied');
    const types = e.sink
      .events()
      .filter((x) => x.action === 'resolve.human-task')
      .map((x) => x.type);
    assert.ok(types.includes('humantask.attempted'));
    assert.ok(!types.includes('humantask.resolved'), 'the failed completion was never faked');
    assert.ok(types.includes('humantask.failed'), 'the duplicate was recorded as failed');
  });
});
