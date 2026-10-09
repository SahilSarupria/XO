import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TestServer, withTempDir } from './test-helpers.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';

interface SourceWire {
  readonly sourceId: string;
}
interface CompilationWire {
  readonly compilationId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}
interface CapabilityWire {
  readonly capabilityId: string;
  readonly status: string;
  readonly executionClass?: string;
  readonly approved: boolean;
}
interface HumanTaskInfoWire {
  readonly status: 'pending' | 'resolved';
  readonly decision?: 'approve' | 'reject';
  readonly decisionData?: Readonly<Record<string, unknown>>;
  readonly resolvedAt?: string;
  readonly resolverIdentityId?: string;
  readonly resumeOutcome?: { readonly kind: string; readonly errorCode?: string; readonly errorMessage?: string };
}
interface ExecutionWire {
  readonly executionId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly sourceXoirNodeIds?: readonly string[];
  readonly status: 'succeeded' | 'failed' | 'waiting_for_human';
  readonly output?: unknown;
  readonly humanTask?: HumanTaskInfoWire;
}

const COMMERCIAL_PROPERTY_PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));
const DETERMINISTIC_CAPABILITY_ID = 'cap_rule_0f731679e7120779542267faaabe10ff';
const HITL_CAPABILITY_ID = 'cap_ce5ac3d1b7e3d22d184b1d089f8c3522'; // "Review not covered under standard rule" — the fixture's one human_in_the_loop capability

async function createWorkspace(server: TestServer, extraHeaders?: Readonly<Record<string, string>>): Promise<WorkspaceRecord> {
  return (await server.request('POST', '/workspaces', {}, extraHeaders)).json<WorkspaceRecord>();
}

async function uploadAndCompile(server: TestServer, workspaceId: string, extraHeaders?: Readonly<Record<string, string>>): Promise<{ compilationId: string }> {
  const pdfBytes = await readFile(COMMERCIAL_PROPERTY_PDF);
  const source = (await server.request('POST', `/workspaces/${workspaceId}/sources?filename=policy.pdf`, pdfBytes, extraHeaders)).json<SourceWire>();
  const compiled = (await server.request('POST', `/workspaces/${workspaceId}/sources/${source.sourceId}/compile`, undefined, extraHeaders)).json<CompilationWire>();
  assert.equal(compiled.status, 'succeeded', 'test fixture setup: expected compilation to succeed');
  return { compilationId: compiled.compilationId };
}

async function approveAndExecuteHitl(server: TestServer, workspaceId: string, compilationId: string): Promise<ExecutionWire> {
  await server.request('POST', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities/${HITL_CAPABILITY_ID}/approve`);
  const execRes = await server.request('POST', `/workspaces/${workspaceId}/executions`, { compilationId, capabilityId: HITL_CAPABILITY_ID, input: {} });
  assert.equal(execRes.status, 201);
  return execRes.json<ExecutionWire>();
}

test('full HITL demo: waiting_for_human -> list pending tasks -> retrieve task -> resolve -> real resume result -> persists after restart -> second resolution cannot overwrite', async () => {
  await withTempDir('xo-api-data-', async (dataDir) => {
    await withTempDir('xo-api-workspaces-', async (workspacesDir) => {
      const identityId = 'demo-identity';
      let workspaceId: string;
      let compilationId: string;
      let executionId: string;

      const server1 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      try {
        // 1-4. Create workspace, upload, compile, retrieve capabilities.
        const workspace = await createWorkspace(server1);
        workspaceId = workspace.workspaceId;
        const result = await uploadAndCompile(server1, workspaceId);
        compilationId = result.compilationId;

        const capsRes = await server1.request('GET', `/workspaces/${workspaceId}/compilations/${compilationId}/capabilities`);
        const caps = capsRes.json<{ capabilities: readonly CapabilityWire[] }>().capabilities;
        const hitl = caps.find((c) => c.capabilityId === HITL_CAPABILITY_ID);
        assert.ok(hitl, 'expected the pinned HITL capability to be discovered');
        assert.equal(hitl.executionClass, 'human_in_the_loop');
        console.log(`[P0.6 demo] selected capability "${HITL_CAPABILITY_ID}" is classified: ${hitl.executionClass}`);

        // 5-7. Approve and execute; verify waiting_for_human.
        const execution = await approveAndExecuteHitl(server1, workspaceId, compilationId);
        executionId = execution.executionId;
        assert.equal(execution.status, 'waiting_for_human');
        assert.equal(execution.humanTask?.status, 'pending');

        // 8. List pending human tasks.
        const listRes = await server1.request('GET', `/workspaces/${workspaceId}/human-tasks`);
        assert.equal(listRes.status, 200);
        const tasks = listRes.json<{ humanTasks: readonly ExecutionWire[] }>().humanTasks;
        assert.ok(tasks.some((t) => t.executionId === executionId && t.humanTask?.status === 'pending'));

        // 9. Retrieve the specific human task.
        const getRes = await server1.request('GET', `/workspaces/${workspaceId}/human-tasks/${executionId}`);
        assert.equal(getRes.status, 200);
        assert.equal(getRes.json<ExecutionWire>().executionId, executionId);

        // 10. Resolve with a valid decision.
        const resolveRes = await server1.request('POST', `/workspaces/${workspaceId}/executions/${executionId}/resolve`, { decision: 'approve' });
        assert.equal(resolveRes.status, 200);
        const resolved = resolveRes.json<ExecutionWire>();

        // 11-13. Real resume (P0.7): the human-in-the-loop task
        // genuinely completes. For this production fixture's binding
        // (ActionEscalationBindingResolver), the re-invoked runtime call
        // deterministically reproduces the same escalation — combined
        // with the human's own recorded approval, that IS this task's
        // honest completion (see resume-human-task.ts's doc comment).
        assert.equal(resolved.humanTask?.status, 'resolved');
        assert.equal(resolved.humanTask?.decision, 'approve');
        assert.equal(resolved.humanTask?.resumeOutcome?.kind, 'succeeded');
        const resumeOutput = resolved.humanTask?.resumeOutcome as { output?: { status?: string; originalEscalation?: { status?: string } } } | undefined;
        assert.equal(resumeOutput?.output?.status, 'human_confirmed');
        assert.equal(resumeOutput?.output?.originalEscalation?.status, 'escalation_required');
        // The underlying execution status genuinely transitions — this is the real, honest result of the resume.
        assert.equal(resolved.status, 'succeeded');
        assert.deepEqual(resolved.output, resumeOutput?.output);
        // Provenance: execution id and contract/binding/source-node-id chain all preserved across the resume.
        assert.equal(resolved.executionId, executionId);
        assert.equal(resolved.contractId, execution.contractId);
        assert.equal(resolved.bindingId, execution.bindingId);
        assert.deepEqual(resolved.sourceXoirNodeIds, execution.sourceXoirNodeIds);
      } finally {
        await server1.stop();
      }

      // 12. Verify decision + resolver identity persist after restart.
      const server2 = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir }, identityId);
      try {
        const fetched = await server2.request('GET', `/workspaces/${workspaceId}/human-tasks/${executionId}`);
        assert.equal(fetched.status, 200);
        const record = fetched.json<ExecutionWire>();
        assert.equal(record.humanTask?.decision, 'approve');
        assert.equal(record.humanTask?.resolverIdentityId, identityId);

        // 13. Attempt a second resolution and verify it cannot overwrite the first.
        const secondResolve = await server2.request('POST', `/workspaces/${workspaceId}/executions/${executionId}/resolve`, { decision: 'reject' });
        assert.equal(secondResolve.status, 409);
        const afterSecond = secondResolve.json<ExecutionWire>();
        assert.equal(afterSecond.humanTask?.decision, 'approve'); // NOT overwritten to 'reject'

        // Confirm via a fresh GET too.
        const reFetched = await server2.request('GET', `/workspaces/${workspaceId}/human-tasks/${executionId}`);
        assert.equal(reFetched.json<ExecutionWire>().humanTask?.decision, 'approve');
      } finally {
        await server2.stop();
      }
    });
  });
});

test('invalid decisions are rejected with 400', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspace.workspaceId);
    const execution = await approveAndExecuteHitl(server, workspace.workspaceId, compilationId);

    for (const badDecision of ['maybe', 'yes', '', 123, null]) {
      const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions/${execution.executionId}/resolve`, { decision: badDecision });
      assert.equal(res.status, 400, `expected 400 for decision ${JSON.stringify(badDecision)}`);
    }

    // Non-object "data" is also rejected.
    const badData = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions/${execution.executionId}/resolve`, { decision: 'approve', data: 'not-an-object' });
    assert.equal(badData.status, 400);

    // The task must still be pending — none of the bad requests resolved it.
    const stillPending = await server.request('GET', `/workspaces/${workspace.workspaceId}/human-tasks/${execution.executionId}`);
    assert.equal(stillPending.json<ExecutionWire>().humanTask?.status, 'pending');
  } finally {
    await server.stop();
  }
});

test('a non-HITL execution cannot be resolved as a human task (400), and does not appear in the human-tasks list', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspace.workspaceId);
    await server.request('POST', `/workspaces/${workspace.workspaceId}/compilations/${compilationId}/capabilities/${DETERMINISTIC_CAPABILITY_ID}/approve`);
    const execRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions`, { compilationId, capabilityId: DETERMINISTIC_CAPABILITY_ID, input: { claim_amount: 15000, loss: 'fire' } });
    const execution = execRes.json<ExecutionWire>();
    assert.equal(execution.status, 'succeeded');

    const resolveRes = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions/${execution.executionId}/resolve`, { decision: 'approve' });
    assert.equal(resolveRes.status, 400);

    const getHumanTask = await server.request('GET', `/workspaces/${workspace.workspaceId}/human-tasks/${execution.executionId}`);
    assert.equal(getHumanTask.status, 404);

    const listed = await server.request('GET', `/workspaces/${workspace.workspaceId}/human-tasks`);
    const ids = listed.json<{ humanTasks: readonly ExecutionWire[] }>().humanTasks.map((t) => t.executionId);
    assert.ok(!ids.includes(execution.executionId));
  } finally {
    await server.stop();
  }
});

test('unknown workspace returns 404 on human-task and resolve routes', async () => {
  const server = await TestServer.start();
  try {
    const unknownId = 'ws_ffffffffffffffffffffffffffffffff';
    assert.equal((await server.request('GET', `/workspaces/${unknownId}/human-tasks`)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${unknownId}/human-tasks/exe_ffffffffffffffffffffffffffffffff`)).status, 404);
    assert.equal((await server.request('POST', `/workspaces/${unknownId}/executions/exe_ffffffffffffffffffffffffffffffff/resolve`, { decision: 'approve' })).status, 404);
  } finally {
    await server.stop();
  }
});

test('cross-identity workspace access returns 404 on human-task and resolve routes', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspace.workspaceId);
    const execution = await approveAndExecuteHitl(server, workspace.workspaceId, compilationId);

    const other = await server.issueAdditionalIdentity('identity-b');
    const asOther = TestServer.authHeader(other.apiKey);

    assert.equal((await server.request('GET', `/workspaces/${workspace.workspaceId}/human-tasks`, undefined, asOther)).status, 404);
    assert.equal((await server.request('GET', `/workspaces/${workspace.workspaceId}/human-tasks/${execution.executionId}`, undefined, asOther)).status, 404);
    assert.equal((await server.request('POST', `/workspaces/${workspace.workspaceId}/executions/${execution.executionId}/resolve`, { decision: 'approve' }, asOther)).status, 404);

    // Confirm the owner can still resolve it — nothing was consumed by the rejected cross-identity attempts.
    const ownerResolve = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions/${execution.executionId}/resolve`, { decision: 'approve' });
    assert.equal(ownerResolve.status, 200);
  } finally {
    await server.stop();
  }
});

test('cross-workspace execution access returns 404: a human task from workspace A cannot be listed, retrieved, or resolved through workspace B', async () => {
  const server = await TestServer.start();
  try {
    const workspaceA = await createWorkspace(server);
    const workspaceB = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspaceA.workspaceId);
    const execution = await approveAndExecuteHitl(server, workspaceA.workspaceId, compilationId);

    assert.equal((await server.request('GET', `/workspaces/${workspaceB.workspaceId}/human-tasks/${execution.executionId}`)).status, 404);
    assert.equal((await server.request('POST', `/workspaces/${workspaceB.workspaceId}/executions/${execution.executionId}/resolve`, { decision: 'approve' })).status, 404);

    const listB = await server.request('GET', `/workspaces/${workspaceB.workspaceId}/human-tasks`);
    assert.deepEqual(listB.json<{ humanTasks: readonly ExecutionWire[] }>().humanTasks, []);
  } finally {
    await server.stop();
  }
});

test('a client cannot override identity, execution class, capability, or runtime declaration via the resolve request body', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const { compilationId } = await uploadAndCompile(server, workspace.workspaceId);
    const execution = await approveAndExecuteHitl(server, workspace.workspaceId, compilationId);

    const res = await server.request('POST', `/workspaces/${workspace.workspaceId}/executions/${execution.executionId}/resolve`, {
      decision: 'approve',
      identityId: 'someone-else',
      resolverIdentityId: 'someone-else',
      capabilityId: 'cap_totally_different',
      executionClass: 'deterministic_rule',
      runtimeDeclaration: { evaluate: 'ignored' },
      status: 'succeeded',
    });
    assert.equal(res.status, 200);
    const resolved = res.json<ExecutionWire>();
    assert.equal(resolved.humanTask?.resolverIdentityId, server.identityId);
    assert.notEqual(resolved.humanTask?.resolverIdentityId, 'someone-else');
    assert.equal(resolved.capabilityId, HITL_CAPABILITY_ID); // unchanged, not "cap_totally_different"
    // The resume outcome is the REAL, re-derived ActionEscalationBindingResolver result
    // (a "human_confirmed" wrapper around the original escalation) — never the shape a
    // smuggled "deterministic_rule"/runtimeDeclaration override would have produced.
    assert.equal(resolved.status, 'succeeded');
    const output = resolved.output as { status?: string } | undefined;
    assert.equal(output?.status, 'human_confirmed');
  } finally {
    await server.stop();
  }
});

test('unauthenticated requests to human-task and resolve routes are rejected (401)', async () => {
  const server = await TestServer.start();
  try {
    const workspace = await createWorkspace(server);
    const calls: readonly [string, string][] = [
      ['GET', `/workspaces/${workspace.workspaceId}/human-tasks`],
      ['GET', `/workspaces/${workspace.workspaceId}/human-tasks/exe_ffffffffffffffffffffffffffffffff`],
      ['POST', `/workspaces/${workspace.workspaceId}/executions/exe_ffffffffffffffffffffffffffffffff/resolve`],
    ];
    for (const [method, path] of calls) {
      const res = await server.request(method, path, method === 'POST' ? { decision: 'approve' } : undefined, {}, { skipAuth: true });
      assert.equal(res.status, 401, `expected 401 for unauthenticated ${method} ${path}`);
    }
  } finally {
    await server.stop();
  }
});
