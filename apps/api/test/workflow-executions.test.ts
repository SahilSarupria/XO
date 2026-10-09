import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFsBlobStore } from '@xo/storage';
import { TestServer, withTempDir } from './test-helpers.js';
import { FIXTURE_CAPABILITY_IDS as IDS, storeFixtureCompilation } from './workflow-fixtures.js';
import type { WorkspaceRecord } from '../src/workspace/workspace.js';
import { FsWorkflowExecutionStore, mintWorkflowExecutionId } from '../src/workflows/fs-workflow-execution-store.js';
import { FsExecutionStore } from '../src/executions/fs-execution-store.js';
import { StaleWorkflowRevisionError } from '../src/workflows/workflow-execution.js';
import { openApiDocument } from '../src/openapi.js';

// ---------------------------------------------------------------------------
// Wire shapes (only what these tests read)
// ---------------------------------------------------------------------------

interface StepWire {
  readonly stepId: string;
  readonly order: number;
  readonly capabilityId: string;
  readonly status: string;
  readonly executionId?: string;
  readonly supersededExecutionIds?: readonly string[];
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
  readonly startedAt?: string;
  readonly completedAt?: string;
}
interface WorkflowExecutionWire {
  readonly workflowExecutionId: string;
  readonly workspaceId: string;
  readonly identityId: string;
  readonly compilationId: string;
  readonly workflowId: string;
  readonly status: string;
  readonly revision: number;
  readonly input: Record<string, unknown>;
  readonly steps: readonly StepWire[];
  readonly currentStepIndex: number | null;
  readonly currentStepExecutionId?: string;
  readonly pendingHumanTask?: { readonly stepIndex: number; readonly executionId: string; readonly humanTaskStatus: string };
  readonly completedStepExecutionIds: readonly string[];
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly finalResult?: { readonly outcome: string; readonly stepResults: readonly { readonly order: number; readonly capabilityId: string; readonly executionId: string; readonly output: unknown }[] };
  readonly rejection?: { readonly stepIndex: number; readonly executionId: string; readonly decision: string };
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly provenance: { readonly compilationId: string; readonly workflowId: string; readonly graphHash?: string; readonly steps: readonly { readonly order: number; readonly capabilityId: string; readonly contractId?: string; readonly bindingId?: string; readonly executionId?: string }[] };
}
interface WorkflowViewWire {
  readonly workflowId: string;
  readonly compilationId: string;
  readonly status: string;
  readonly executable: boolean;
  readonly notExecutableReasons: readonly string[];
  readonly steps: readonly { readonly order: number; readonly capabilityId: string; readonly executionClass?: string; readonly bound: boolean; readonly approved: boolean }[];
  readonly dataFlow: { readonly provenBindings: readonly { readonly producerCapabilityId: string; readonly outputParameterName: string; readonly consumerCapabilityId: string; readonly inputParameterName: string; readonly wired: boolean }[] };
}
interface ExecutionWire {
  readonly executionId: string;
  readonly compilationId: string;
  readonly capabilityId: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly graphHash?: string;
  readonly contractContentHash?: string;
  readonly status: string;
  readonly input: Record<string, unknown>;
  readonly output?: { readonly matched?: boolean; readonly outcome?: string; readonly status?: string };
  readonly humanTask?: { readonly status: string; readonly decision?: string; readonly resolvedAt?: string };
  readonly requestedAt: string;
  readonly completedAt?: string;
}
interface ErrorWire {
  readonly error: { readonly code: string; readonly message: string; readonly context?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Harness: real HTTP server + real filesystem stores in temp dirs
// ---------------------------------------------------------------------------

interface Env {
  readonly dataDir: string;
  readonly workspacesDir: string;
  server: TestServer;
  readonly workspace: WorkspaceRecord;
  readonly compilationId: string;
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  await withTempDir('xo-p08-data-', async (dataDir) => {
    await withTempDir('xo-p08-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      const env: { -readonly [K in keyof Env]: Env[K] } = { dataDir, workspacesDir, server, workspace: undefined as never, compilationId: '' };
      try {
        env.workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        env.compilationId = (await storeFixtureCompilation(env.workspace, dataDir)).compilationId;
        await fn(env);
      } finally {
        await env.server.stop();
      }
    });
  });
}

const ws = (env: Env, suffix: string): string => `/workspaces/${env.workspace.workspaceId}${suffix}`;

async function approve(env: Env, capabilityId: string, compilationId = env.compilationId): Promise<void> {
  const res = await env.server.request('POST', ws(env, `/compilations/${compilationId}/capabilities/${capabilityId}/approve`));
  assert.ok(res.status === 200 || res.status === 201, `approve ${capabilityId} -> ${res.status} ${res.bodyText}`);
}

async function workflowIdStartingWith(env: Env, firstCapabilityId: string): Promise<string> {
  const res = await env.server.request('GET', ws(env, '/workflows'));
  assert.equal(res.status, 200);
  const found = res.json<{ workflows: WorkflowViewWire[] }>().workflows.find((w) => w.steps[0]?.capabilityId === firstCapabilityId);
  assert.ok(found, `no workflow starts with ${firstCapabilityId}`);
  return found.workflowId;
}

async function startWorkflow(env: Env, firstCapabilityId: string, input: Record<string, unknown>) {
  const workflowId = await workflowIdStartingWith(env, firstCapabilityId);
  return env.server.request('POST', ws(env, `/workflows/${workflowId}/executions`), { compilationId: env.compilationId, input });
}

async function getWorkflowExecution(env: Env, id: string): Promise<WorkflowExecutionWire> {
  const res = await env.server.request('GET', ws(env, `/workflow-executions/${id}`));
  assert.equal(res.status, 200, res.bodyText);
  return res.json<WorkflowExecutionWire>();
}

async function getExecution(env: Env, id: string): Promise<ExecutionWire> {
  const res = await env.server.request('GET', ws(env, `/executions/${id}`));
  assert.equal(res.status, 200, res.bodyText);
  return res.json<ExecutionWire>();
}

async function listExecutions(env: Env): Promise<ExecutionWire[]> {
  return (await env.server.request('GET', ws(env, '/executions'))).json<{ executions: ExecutionWire[] }>().executions;
}

function metadataPath(env: Env, id: string): string {
  return join(env.dataDir, env.workspace.workspaceId, 'workflow-executions', id, 'metadata.json');
}

async function approveHitlChain(env: Env): Promise<void> {
  for (const id of [IDS.hitlA, IDS.hitlB, IDS.hitlC]) await approve(env, id);
}

const HITL_CHAIN_INPUT = { screening_score: 90, settlement_amount: 800 };

/** Starts the A(det) -> B(HITL) -> C(det) workflow; returns the persisted, waiting record. */
async function startHitlChain(env: Env): Promise<WorkflowExecutionWire> {
  await approveHitlChain(env);
  const res = await startWorkflow(env, IDS.hitlA, HITL_CHAIN_INPUT);
  assert.equal(res.status, 201, res.bodyText);
  return res.json<WorkflowExecutionWire>();
}

// ---------------------------------------------------------------------------
// 1. Discovery
// ---------------------------------------------------------------------------

test('discovery: GET /workflows exposes every workflow composed from the stored compilation with its verbatim executability status, ordered steps, and proven-binding evidence', async () => {
  await withEnv(async (env) => {
    const res = await env.server.request('GET', ws(env, '/workflows'));
    assert.equal(res.status, 200);
    const { workflows } = res.json<{ workflows: WorkflowViewWire[] }>();
    assert.equal(workflows.length, 7);
    for (const w of workflows) assert.equal(w.compilationId, env.compilationId);

    const byFirst = (id: string) => workflows.find((w) => w.steps[0]?.capabilityId === id)!;

    const flow = byFirst(IDS.flowA);
    assert.equal(flow.status, 'executable_candidate');
    assert.equal(flow.executable, true);
    assert.deepEqual(flow.steps.map((s) => [s.order, s.capabilityId, s.executionClass, s.bound, s.approved]), [
      [0, IDS.flowA, 'deterministic_rule', true, false],
      [1, IDS.flowB, 'deterministic_rule', true, false],
    ]);
    assert.deepEqual(flow.dataFlow.provenBindings, [{ producerCapabilityId: IDS.flowA, outputParameterName: 'matched', consumerCapabilityId: IDS.flowB, inputParameterName: 'matched', wired: true }]);

    const chain = byFirst(IDS.hitlA);
    assert.deepEqual(chain.steps.map((s) => [s.capabilityId, s.executionClass]), [
      [IDS.hitlA, 'deterministic_rule'],
      [IDS.hitlB, 'human_in_the_loop'],
      [IDS.hitlC, 'deterministic_rule'],
    ]);

    // Statuses are preserved verbatim, never upgraded.
    assert.equal(byFirst(IDS.orphan).status, 'not_executable_yet');
    assert.equal(byFirst(IDS.orphan).executable, false);
    assert.ok(byFirst(IDS.orphan).notExecutableReasons.length > 0);
    assert.equal(byFirst(IDS.cycleX).status, 'semantically_invalid');
    assert.equal(byFirst(IDS.cycleX).executable, false);

    // approval state is reflected per step
    await approve(env, IDS.flowA);
    const after = (await env.server.request('GET', ws(env, '/workflows'))).json<{ workflows: WorkflowViewWire[] }>().workflows;
    assert.deepEqual(after.find((w) => w.steps[0]?.capabilityId === IDS.flowA)!.steps.map((s) => s.approved), [true, false]);

    // filter + 404 + auth
    const filtered = await env.server.request('GET', ws(env, `/workflows?compilationId=${env.compilationId}`));
    assert.equal(filtered.json<{ workflows: unknown[] }>().workflows.length, 7);
    assert.equal((await env.server.request('GET', ws(env, '/workflows?compilationId=comp_doesnotexist'))).status, 404);
    assert.equal((await env.server.request('GET', ws(env, '/workflows'), undefined, {}, { skipAuth: true })).status, 401);
  });
});

// ---------------------------------------------------------------------------
// 2, 5, 6, 7, 8 — deterministic multi-step workflow with proven data flow
// ---------------------------------------------------------------------------

test('a deterministic two-step workflow executes sequentially through the existing runtime, persists workflow + step state, and transfers the proven producer output into the consumer input', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const res = await startWorkflow(env, IDS.flowA, { claim_amount: 15000, payout_amount: 800 });
    assert.equal(res.status, 201, res.bodyText);
    const wf = res.json<WorkflowExecutionWire>();

    assert.equal(wf.status, 'succeeded');
    assert.equal(wf.workspaceId, env.workspace.workspaceId);
    assert.equal(wf.identityId, env.server.identityId);
    assert.equal(wf.compilationId, env.compilationId);
    assert.deepEqual(wf.steps.map((s) => s.status), ['succeeded', 'succeeded']);
    assert.deepEqual(wf.steps.map((s) => s.capabilityId), [IDS.flowA, IDS.flowB]);
    assert.equal(wf.currentStepIndex, null);
    assert.ok(wf.startedAt && wf.completedAt);
    assert.equal(wf.finalResult?.outcome, 'completed');
    assert.equal(wf.completedStepExecutionIds.length, 2);

    const [a, b] = await Promise.all(wf.steps.map((s) => getExecution(env, s.executionId!)));
    // #7 sequential: A fully completed before B was created
    assert.ok(a!.completedAt! <= b!.requestedAt, `A completed ${a!.completedAt} before B requested ${b!.requestedAt}`);
    assert.ok(wf.steps[0]!.completedAt! <= wf.steps[1]!.startedAt!);

    // #8 data flow: A's real evaluated output (matched:true since 15000 > 10000) became B's input.
    assert.equal(a!.status, 'succeeded');
    assert.equal(a!.output?.matched, true);
    assert.equal(b!.input['matched'], true, 'the proven producer output reached the consumer input');
    assert.equal(b!.input['payout_amount'], 800);
    assert.equal(b!.output?.matched, true);
    assert.equal(b!.output?.outcome, 'release payout');
    // The client never supplied `matched` and it is not in the persisted workflow input.
    assert.equal('matched' in wf.input, false);

    // #5/#6 persisted: retrievable, listed, and identical on disk.
    const got = await getWorkflowExecution(env, wf.workflowExecutionId);
    assert.deepEqual(got, wf);
    const list = (await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: WorkflowExecutionWire[] }>();
    assert.deepEqual(list.workflowExecutions.map((w) => w.workflowExecutionId), [wf.workflowExecutionId]);
    const onDisk = JSON.parse(await readFile(metadataPath(env, wf.workflowExecutionId), 'utf8')) as WorkflowExecutionWire;
    assert.equal(onDisk.status, 'succeeded');
    assert.deepEqual(onDisk.steps.map((s) => s.executionId), wf.steps.map((s) => s.executionId));
    assert.ok(onDisk.revision >= 5, `revision counts every persisted transition (got ${onDisk.revision})`);

    // #22 provenance/execution ids stay correlated
    for (const [i, step] of wf.steps.entries()) {
      const exec = await getExecution(env, step.executionId!);
      assert.equal(exec.compilationId, env.compilationId);
      assert.equal(exec.capabilityId, step.capabilityId);
      assert.equal(exec.contractId, step.contractId);
      assert.equal(exec.bindingId, step.bindingId);
      assert.equal(wf.provenance.steps[i]!.executionId, step.executionId);
      assert.equal(wf.provenance.steps[i]!.bindingId, step.bindingId);
      // P0.9B: every step's underlying execution names the SAME graph the
      // workflow provenance names (execution -> workflow -> graph), and
      // the contract content that ran.
      assert.equal(exec.graphHash, wf.provenance.graphHash);
      assert.match(exec.contractContentHash ?? '', /^sha256:[0-9a-f]{64}$/);
    }
    assert.equal(wf.provenance.compilationId, env.compilationId);
    // P0.9B: the workflow's provenance carries the compiled graph's own
    // identity forward — the same value the compilation's own graph
    // manifest already carries (see compile-sources-graph-hash.test.ts
    // in @xo/compiler for where this value first gets set).
    assert.ok(wf.provenance.graphHash, 'workflow provenance must carry graphHash');
  });
});

test('data flow is value-faithful: a producer that does NOT match transfers matched:false, not a fabricated true', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const wf = (await startWorkflow(env, IDS.flowA, { claim_amount: 100, payout_amount: 800 })).json<WorkflowExecutionWire>();
    assert.equal(wf.status, 'succeeded');
    const b = await getExecution(env, wf.steps[1]!.executionId!);
    assert.equal(b.input['matched'], false);
  });
});

// ---------------------------------------------------------------------------
// 3, 4 — non-executable workflows
// ---------------------------------------------------------------------------

test('not_executable_yet and semantically_invalid workflows are rejected with 422 XO_WORKFLOW_NOT_EXECUTABLE and leave no workflow execution behind', async () => {
  await withEnv(async (env) => {
    for (const [first, status] of [[IDS.orphan, 'not_executable_yet'], [IDS.cycleX, 'semantically_invalid']] as const) {
      const res = await startWorkflow(env, first, {});
      assert.equal(res.status, 422, res.bodyText);
      const body = res.json<ErrorWire>();
      assert.equal(body.error.code, 'XO_WORKFLOW_NOT_EXECUTABLE');
      assert.equal(body.error.context?.['executabilityStatus'], status);
      assert.ok(Array.isArray(body.error.context?.['reasons']) && (body.error.context['reasons'] as unknown[]).length > 0);
    }
    const list = (await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>();
    assert.equal(list.workflowExecutions.length, 0);
    assert.equal((await listExecutions(env)).length, 0);
  });
});

test('starting an unknown workflow id, or a workflow in an unknown compilation, is 404 (not WORKFLOW_NOT_EXECUTABLE)', async () => {
  await withEnv(async (env) => {
    assert.equal((await env.server.request('POST', ws(env, '/workflows/wf_doesnotexist/executions'), { compilationId: env.compilationId })).status, 404);
    const wfId = await workflowIdStartingWith(env, IDS.flowA);
    assert.equal((await env.server.request('POST', ws(env, `/workflows/${wfId}/executions`), { compilationId: 'comp_doesnotexist' })).status, 404);
  });
});

// ---------------------------------------------------------------------------
// 10, 11, 9 — HITL pauses the workflow at the HITL step
// ---------------------------------------------------------------------------

test('a multi-step workflow stops at its HITL step: A executed, B waiting_for_human, C never executed while waiting', async () => {
  await withEnv(async (env) => {
    const wf = await startHitlChain(env);
    assert.equal(wf.status, 'waiting_for_human');
    assert.deepEqual(wf.steps.map((s) => s.status), ['succeeded', 'waiting_for_human', 'pending']);
    assert.equal(wf.currentStepIndex, 1);
    assert.equal(wf.currentStepExecutionId, wf.steps[1]!.executionId);
    assert.deepEqual(wf.pendingHumanTask, { stepIndex: 1, executionId: wf.steps[1]!.executionId, humanTaskStatus: 'pending' });
    assert.equal(wf.completedStepExecutionIds.length, 1);
    assert.equal(wf.finalResult, undefined);
    assert.equal(wf.completedAt, undefined);
    assert.equal(wf.steps[2]!.executionId, undefined, 'the later step has no execution');

    // Only A and B exist as capability executions; C was never run.
    const execs = await listExecutions(env);
    assert.deepEqual(execs.map((e) => e.capabilityId).sort(), [IDS.hitlA, IDS.hitlB].sort());
    const b = await getExecution(env, wf.steps[1]!.executionId!);
    assert.equal(b.status, 'waiting_for_human');
    assert.equal(b.humanTask?.status, 'pending');
    assert.equal(b.output?.status, 'escalation_required');

    // The underlying task is the P0.7 human task, visible through the existing human-task API.
    const tasks = (await env.server.request('GET', ws(env, '/human-tasks'))).json<{ tasks?: ExecutionWire[]; humanTasks?: ExecutionWire[] }>();
    const listed = tasks.tasks ?? tasks.humanTasks ?? [];
    assert.ok(listed.some((t) => t.executionId === b.executionId));

    // Waiting is not success: no decision -> refused, nothing runs.
    const bare = await env.server.request('POST', ws(env, `/workflow-executions/${wf.workflowExecutionId}/resume`), { expectedStepExecutionId: b.executionId });
    assert.equal(bare.status, 400);
    assert.equal((await listExecutions(env)).length, 2);
    assert.equal((await getWorkflowExecution(env, wf.workflowExecutionId)).status, 'waiting_for_human');
  });
});

// ---------------------------------------------------------------------------
// 13, 14, 15, 9 — approve resumes the right step; A is not re-run; C runs; final result persisted
// ---------------------------------------------------------------------------

test('approving the pending HITL step resumes it, runs C, never re-runs A, preserves execution ids, and persists the final result', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const [aId, bId] = [waiting.steps[0]!.executionId!, waiting.steps[1]!.executionId!];

    const res = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve', data: { note: 'looks fine' }, expectedStepExecutionId: bId });
    assert.equal(res.status, 200, res.bodyText);
    const wf = res.json<WorkflowExecutionWire>();

    assert.equal(wf.workflowExecutionId, waiting.workflowExecutionId);
    assert.equal(wf.status, 'succeeded');
    assert.deepEqual(wf.steps.map((s) => s.status), ['succeeded', 'succeeded', 'succeeded']);
    assert.equal(wf.steps[0]!.executionId, aId, 'A keeps its original execution id');
    assert.equal(wf.steps[1]!.executionId, bId, 'B keeps its original execution id');
    assert.equal(wf.pendingHumanTask, undefined);
    assert.deepEqual(wf.completedStepExecutionIds, [aId, bId, wf.steps[2]!.executionId]);
    assert.equal(wf.currentStepIndex, null);
    assert.ok(wf.revision > waiting.revision);

    // #9 exactly three capability executions in total: A was not repeated.
    const execs = await listExecutions(env);
    assert.equal(execs.length, 3);
    assert.equal(execs.filter((e) => e.capabilityId === IDS.hitlA).length, 1);
    assert.equal((await getExecution(env, aId)).status, 'succeeded');

    // B's underlying execution is the P0.7-resolved human task.
    const b = await getExecution(env, bId);
    assert.equal(b.status, 'succeeded');
    assert.equal(b.humanTask?.status, 'resolved');
    assert.equal(b.humanTask?.decision, 'approve');
    assert.equal(b.output?.status, 'human_confirmed');

    // C ran after B and produced a real deterministic result.
    const c = await getExecution(env, wf.steps[2]!.executionId!);
    assert.equal(c.output?.matched, true);
    assert.equal(c.output?.outcome, 'settlement released');
    assert.ok(b.humanTask?.resolvedAt !== undefined ? b.humanTask.resolvedAt <= c.requestedAt : b.completedAt! <= c.requestedAt);

    // #15 final result persisted, on disk and via GET
    assert.equal(wf.finalResult?.outcome, 'completed');
    assert.deepEqual(wf.finalResult?.stepResults.map((r) => [r.order, r.capabilityId, r.executionId]), [
      [0, IDS.hitlA, aId],
      [1, IDS.hitlB, bId],
      [2, IDS.hitlC, wf.steps[2]!.executionId],
    ]);
    const onDisk = JSON.parse(await readFile(metadataPath(env, wf.workflowExecutionId), 'utf8')) as WorkflowExecutionWire;
    assert.deepEqual(onDisk.finalResult, wf.finalResult);
    assert.equal(onDisk.status, 'succeeded');
    assert.deepEqual(await getWorkflowExecution(env, wf.workflowExecutionId), wf);
  });
});

test('a decision-less resume continues a workflow whose human task was already resolved through P0.7 POST /executions/:id/resolve', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const bId = waiting.steps[1]!.executionId!;
    assert.equal((await env.server.request('POST', ws(env, `/executions/${bId}/resolve`), { decision: 'approve' })).status, 200);

    // Read-through: the workflow still waits, but reports the task as resolved.
    const mid = await getWorkflowExecution(env, waiting.workflowExecutionId);
    assert.equal(mid.status, 'waiting_for_human');
    assert.equal(mid.pendingHumanTask?.humanTaskStatus, 'resolved');

    // Multi-step => the expected id is still mandatory.
    assert.equal((await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), {})).status, 400);
    // A decision cannot be applied twice.
    const dup = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve', expectedStepExecutionId: bId });
    assert.equal(dup.status, 409);
    assert.equal(dup.json<ErrorWire>().error.context?.['reason'], 'not_resumable');

    const res = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { expectedStepExecutionId: bId });
    assert.equal(res.status, 200, res.bodyText);
    assert.equal(res.json<WorkflowExecutionWire>().status, 'succeeded');
    assert.equal((await listExecutions(env)).length, 3);
  });
});

// ---------------------------------------------------------------------------
// 16 — rejection
// ---------------------------------------------------------------------------

test('human rejection ends the workflow honestly: step rejected, later step skipped and never executed, workflow rejected, terminal', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const bId = waiting.steps[1]!.executionId!;
    const res = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'reject', data: { note: 'not authorized' }, expectedStepExecutionId: bId });
    assert.equal(res.status, 200, res.bodyText);
    const wf = res.json<WorkflowExecutionWire>();

    assert.equal(wf.status, 'rejected');
    assert.deepEqual(wf.steps.map((s) => s.status), ['succeeded', 'rejected', 'skipped']);
    assert.deepEqual(wf.rejection && { stepIndex: wf.rejection.stepIndex, executionId: wf.rejection.executionId, decision: wf.rejection.decision }, { stepIndex: 1, executionId: bId, decision: 'reject' });
    assert.equal(wf.finalResult, undefined, 'a rejected workflow has no success result');
    assert.equal(wf.pendingHumanTask, undefined);
    assert.equal(wf.currentStepIndex, null);
    assert.ok(wf.completedAt);
    assert.equal((await getExecution(env, bId)).status, 'rejected');
    assert.equal((await listExecutions(env)).length, 2, 'C never executed');

    // Terminal: cannot be resumed again.
    const again = await env.server.request('POST', ws(env, `/workflow-executions/${wf.workflowExecutionId}/resume`), { decision: 'approve', expectedStepExecutionId: bId });
    assert.equal(again.status, 409);
    assert.equal(again.json<ErrorWire>().error.context?.['reason'], 'terminal');
    assert.equal((await getWorkflowExecution(env, wf.workflowExecutionId)).status, 'rejected');
  });
});

// ---------------------------------------------------------------------------
// 17, 18, 19 — concurrency / stale-state protection
// ---------------------------------------------------------------------------

test('two concurrent resumes cannot both continue: exactly one succeeds, the other is a deterministic 409, and no step runs twice', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const bId = waiting.steps[1]!.executionId!;
    const path = ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`);
    const body = { decision: 'approve', expectedStepExecutionId: bId };
    const [r1, r2] = await Promise.all([env.server.request('POST', path, body), env.server.request('POST', path, body)]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], `${r1.bodyText} | ${r2.bodyText}`);
    const loser = [r1, r2].find((r) => r.status === 409)!;
    assert.ok(['terminal', 'stale_step_execution', 'in_flight'].includes(String(loser.json<ErrorWire>().error.context?.['reason'])));

    const final = await getWorkflowExecution(env, waiting.workflowExecutionId);
    assert.equal(final.status, 'succeeded');
    const execs = await listExecutions(env);
    assert.equal(execs.length, 3, 'A, B, C each executed exactly once');
    assert.equal(execs.filter((e) => e.capabilityId === IDS.hitlC).length, 1);
  });
});

test('a duplicate resume after success returns a deterministic terminal 409 and changes nothing', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const bId = waiting.steps[1]!.executionId!;
    const path = ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`);
    assert.equal((await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: bId })).status, 200);
    const before = await getWorkflowExecution(env, waiting.workflowExecutionId);
    const dup = await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: bId });
    assert.equal(dup.status, 409);
    assert.equal(dup.json<ErrorWire>().error.code, 'XO_RUNTIME_SESSION_INVALID_STATE');
    assert.equal(dup.json<ErrorWire>().error.context?.['reason'], 'terminal');
    assert.deepEqual(await getWorkflowExecution(env, waiting.workflowExecutionId), before);
    assert.equal((await listExecutions(env)).length, 3);
  });
});

test('expectedStepExecutionId: required for a multi-step workflow with a pending HITL step; a wrong value is a 409 that applies nothing; a stale id can never resume the NEXT HITL step', async () => {
  await withEnv(async (env) => {
    for (const id of [IDS.twoH1, IDS.twoH2]) await approve(env, id);
    const started = await startWorkflow(env, IDS.twoH1, {});
    assert.equal(started.status, 201, started.bodyText);
    const wf = started.json<WorkflowExecutionWire>();
    assert.equal(wf.status, 'waiting_for_human');
    assert.deepEqual(wf.steps.map((s) => s.status), ['waiting_for_human', 'pending']);
    const h1 = wf.steps[0]!.executionId!;
    const path = ws(env, `/workflow-executions/${wf.workflowExecutionId}/resume`);

    // missing -> 400
    const missing = await env.server.request('POST', path, { decision: 'approve' });
    assert.equal(missing.status, 400);
    assert.equal(missing.json<ErrorWire>().error.context?.['reason'], 'expected_step_execution_id_required');

    // wrong -> 409, and the human task was NOT resolved
    const wrong = await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: 'exec_00000000000000000000000000000000' });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json<ErrorWire>().error.context?.['reason'], 'stale_step_execution');
    assert.equal((await getExecution(env, h1)).humanTask?.status, 'pending');
    assert.equal((await getWorkflowExecution(env, wf.workflowExecutionId)).revision, wf.revision, 'nothing was persisted');

    // correct -> continues to the SECOND HITL step and stops again with a NEW pending task
    const next = await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: h1 });
    assert.equal(next.status, 200, next.bodyText);
    const atH2 = next.json<WorkflowExecutionWire>();
    assert.equal(atH2.status, 'waiting_for_human');
    assert.deepEqual(atH2.steps.map((s) => s.status), ['succeeded', 'waiting_for_human']);
    const h2 = atH2.steps[1]!.executionId!;
    assert.notEqual(h2, h1);
    assert.equal(atH2.pendingHumanTask?.executionId, h2);

    // The same (now stale) request, replayed, must NOT approve H2.
    const replay = await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: h1 });
    assert.equal(replay.status, 409);
    assert.equal(replay.json<ErrorWire>().error.context?.['reason'], 'stale_step_execution');
    assert.equal((await getExecution(env, h2)).humanTask?.status, 'pending');
    assert.equal((await getWorkflowExecution(env, wf.workflowExecutionId)).status, 'waiting_for_human');

    // The right id finishes it.
    const done = await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: h2 });
    assert.equal(done.status, 200, done.bodyText);
    assert.equal(done.json<WorkflowExecutionWire>().status, 'succeeded');
  });
});

test('stale revision: expectedRevision that no longer matches is a deterministic 409 and never modifies the stored workflow', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const path = ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`);
    const stale = await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: waiting.steps[1]!.executionId, expectedRevision: waiting.revision - 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json<ErrorWire>().error.context?.['reason'], 'stale_revision');
    assert.deepEqual(await getWorkflowExecution(env, waiting.workflowExecutionId), waiting);
    assert.equal((await getExecution(env, waiting.steps[1]!.executionId!)).humanTask?.status, 'pending');

    // the current revision is accepted
    const ok = await env.server.request('POST', path, { decision: 'approve', expectedStepExecutionId: waiting.steps[1]!.executionId, expectedRevision: waiting.revision });
    assert.equal(ok.status, 200, ok.bodyText);
  });
});

test('FsWorkflowExecutionStore.save is compare-and-swap: a stale expected revision fails and leaves the newer stored state untouched', async () => {
  await withTempDir('xo-p08-store-', async (dir) => {
    const store = new FsWorkflowExecutionStore(new LocalFsBlobStore(dir));
    const id = mintWorkflowExecutionId();
    const created = await store.create('ws_x', 'ident_x', { workflowExecutionId: id, compilationId: 'comp_x', workflowId: 'wf_x', workflowName: 'x', input: {}, steps: [{ stepId: 's#0', order: 0, capabilityId: 'cap_x', capabilityName: 'x' }] });
    assert.ok(created.ok);
    assert.equal(created.value.revision, 0);

    const v1 = await store.save({ ...created.value, revision: 1, status: 'running' }, 0);
    assert.ok(v1.ok);
    // a writer still holding revision 0 now tries to overwrite
    const stale = await store.save({ ...created.value, revision: 1, status: 'failed', errorCode: 'X' }, 0);
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.ok(stale.error instanceof StaleWorkflowRevisionError);
      assert.equal((stale.error as StaleWorkflowRevisionError).expectedRevision, 0);
      assert.equal((stale.error as StaleWorkflowRevisionError).actualRevision, 1);
    }
    const stored = await store.get(id);
    assert.ok(stored.ok);
    assert.equal(stored.value.status, 'running');
    assert.equal(stored.value.revision, 1);
    // a mis-numbered next revision is refused outright
    const bad = await store.save({ ...v1.value, revision: 5 }, 1);
    assert.equal(bad.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 12, 24 — restart and recovery (real filesystem, second server instance on the same directories)
// ---------------------------------------------------------------------------

test('a pending HITL workflow survives a server restart and then completes', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const bId = waiting.steps[1]!.executionId!;

    await env.server.stop();
    env.server = await TestServer.start({ workspaceDataDir: env.dataDir, workspacesDir: env.workspacesDir });

    const after = await getWorkflowExecution(env, waiting.workflowExecutionId);
    assert.deepEqual(after, waiting, 'identical persisted state after restart');
    assert.equal(after.status, 'waiting_for_human');
    assert.deepEqual(after.steps.map((s) => s.status), ['succeeded', 'waiting_for_human', 'pending']);
    const listed = (await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: WorkflowExecutionWire[] }>();
    assert.equal(listed.workflowExecutions.length, 1);

    const res = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve', expectedStepExecutionId: bId });
    assert.equal(res.status, 200, res.bodyText);
    const done = res.json<WorkflowExecutionWire>();
    assert.equal(done.status, 'succeeded');
    assert.equal(done.steps[0]!.executionId, waiting.steps[0]!.executionId);
    assert.equal((await listExecutions(env)).length, 3, 'A was not re-executed by the post-restart continuation');
  });
});

test('recovery A — a step left `running` whose execution never completed is reported interrupted (never claimed done); an explicit resume re-executes ONLY that step under a new execution id, then the workflow finishes', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const aExec = waiting.steps[0]!.executionId!;

    // Reproduce exactly what a crash between "step marked running" and "execution completed" leaves on disk:
    // an ExecutionRecord created but never completed, and a workflow record that says the step is running.
    const execStore = new FsExecutionStore(new LocalFsBlobStore(join(env.dataDir, env.workspace.workspaceId, 'executions')));
    const orphan = await execStore.create(env.workspace.workspaceId, env.workspace.identityId, { compilationId: env.compilationId, capabilityId: IDS.hitlB, input: HITL_CHAIN_INPUT });
    assert.ok(orphan.ok);
    const crashed = { ...waiting, status: 'running', steps: waiting.steps.map((s, i) => (i === 1 ? { ...s, status: 'running', executionId: orphan.value.executionId } : s)) } as Record<string, unknown>;
    delete crashed['pendingHumanTask'];
    await writeFile(metadataPath(env, waiting.workflowExecutionId), JSON.stringify(crashed));

    await env.server.stop();
    env.server = await TestServer.start({ workspaceDataDir: env.dataDir, workspacesDir: env.workspacesDir });

    const recovered = await getWorkflowExecution(env, waiting.workflowExecutionId);
    assert.equal(recovered.status, 'interrupted');
    assert.deepEqual(recovered.steps.map((s) => s.status), ['succeeded', 'interrupted', 'pending']);
    assert.equal(recovered.finalResult, undefined);
    // idempotent: reading again does not re-transition
    assert.equal((await getWorkflowExecution(env, waiting.workflowExecutionId)).revision, recovered.revision);
    // the abandoned execution is not silently marked successful
    assert.notEqual((await getExecution(env, orphan.value.executionId)).status, 'succeeded');

    // A decision cannot be supplied to an interrupted workflow (no pending human task).
    assert.equal((await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve' })).status, 400);

    const resumed = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), {});
    assert.equal(resumed.status, 200, resumed.bodyText);
    const atB = resumed.json<WorkflowExecutionWire>();
    assert.equal(atB.status, 'waiting_for_human');
    assert.equal(atB.steps[0]!.executionId, aExec, 'A was not re-run');
    const newB = atB.steps[1]!.executionId!;
    assert.notEqual(newB, orphan.value.executionId);
    assert.deepEqual(atB.steps[1]!.supersededExecutionIds, [orphan.value.executionId]);

    const done = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve', expectedStepExecutionId: newB });
    assert.equal(done.status, 200, done.bodyText);
    assert.equal(done.json<WorkflowExecutionWire>().status, 'succeeded');
    assert.equal(done.json<WorkflowExecutionWire>().steps[0]!.executionId, aExec);
  });
});

test('recovery B — a step left `running` whose execution DID complete before the crash has its recorded outcome adopted, not re-executed', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const bId = waiting.steps[1]!.executionId!;
    // crash after the human-task execution completed (waiting_for_human) but before the workflow record advanced
    const crashed = { ...waiting, status: 'running', steps: waiting.steps.map((s, i) => (i === 1 ? { ...s, status: 'running' } : s)) } as Record<string, unknown>;
    delete crashed['pendingHumanTask'];
    await writeFile(metadataPath(env, waiting.workflowExecutionId), JSON.stringify(crashed));

    await env.server.stop();
    env.server = await TestServer.start({ workspaceDataDir: env.dataDir, workspacesDir: env.workspacesDir });

    const recovered = await getWorkflowExecution(env, waiting.workflowExecutionId);
    assert.equal(recovered.status, 'waiting_for_human');
    assert.equal(recovered.pendingHumanTask?.executionId, bId);
    assert.equal(recovered.steps[1]!.executionId, bId);
    assert.equal((await listExecutions(env)).length, 2, 'nothing was re-executed');
  });
});

test('proven data flow survives a human pause AND a server restart: A\'s persisted output reaches C\'s input after B is approved', async () => {
  await withEnv(async (env) => {
    for (const id of [IDS.xsegA, IDS.xsegH, IDS.xsegC]) await approve(env, id);
    const res = await startWorkflow(env, IDS.xsegA, { intake_score: 80, review_amount: 900 });
    assert.equal(res.status, 201, res.bodyText);
    const waiting = res.json<WorkflowExecutionWire>();
    assert.equal(waiting.status, 'waiting_for_human');
    assert.deepEqual(waiting.steps.map((s) => s.status), ['succeeded', 'waiting_for_human', 'pending']);
    assert.equal((waiting.steps[0]!.result as { matched?: boolean }).matched, true);

    await env.server.stop();
    env.server = await TestServer.start({ workspaceDataDir: env.dataDir, workspacesDir: env.workspacesDir });

    const done = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve', expectedStepExecutionId: waiting.steps[1]!.executionId });
    assert.equal(done.status, 200, done.bodyText);
    const wf = done.json<WorkflowExecutionWire>();
    assert.equal(wf.status, 'succeeded');
    const c = await getExecution(env, wf.steps[2]!.executionId!);
    assert.equal(c.input['matched'], true, "A's output crossed the human pause and the restart");
    assert.equal(c.input['review_amount'], 900);
    assert.equal(c.output?.outcome, 'intake settled');
    assert.equal((await listExecutions(env)).length, 3);
  });
});

// ---------------------------------------------------------------------------
// 20, 21 — cross-workspace isolation
// ---------------------------------------------------------------------------

test('cross-workspace and cross-identity access to workflows and workflow executions is 404', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const wfId = await workflowIdStartingWith(env, IDS.hitlA);

    // (a) a second workspace of the SAME identity cannot see or use the first workspace's data
    const other = (await env.server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
    const otherPath = (suffix: string): string => `/workspaces/${other.workspaceId}${suffix}`;
    assert.equal((await env.server.request('GET', otherPath(`/workflow-executions/${waiting.workflowExecutionId}`))).status, 404);
    assert.equal((await env.server.request('POST', otherPath(`/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve', expectedStepExecutionId: waiting.steps[1]!.executionId })).status, 404);
    assert.equal((await env.server.request('GET', otherPath('/workflow-executions'))).json<{ workflowExecutions: unknown[] }>().workflowExecutions.length, 0);
    assert.equal((await env.server.request('GET', otherPath('/workflows'))).json<{ workflows: unknown[] }>().workflows.length, 0);
    assert.equal((await env.server.request('POST', otherPath(`/workflows/${wfId}/executions`), { compilationId: env.compilationId, input: HITL_CHAIN_INPUT })).status, 404);

    // (b) a different identity cannot address the first workspace at all
    const intruder = await env.server.issueAdditionalIdentity('someone-else');
    const h = TestServer.authHeader(intruder.apiKey);
    for (const [method, suffix, body] of [
      ['GET', '/workflows', undefined],
      ['GET', '/workflow-executions', undefined],
      ['GET', `/workflow-executions/${waiting.workflowExecutionId}`, undefined],
      ['POST', `/workflow-executions/${waiting.workflowExecutionId}/resume`, { decision: 'approve', expectedStepExecutionId: waiting.steps[1]!.executionId }],
      ['POST', `/workflows/${wfId}/executions`, { compilationId: env.compilationId }],
    ] as const) {
      const res = await env.server.request(method, ws(env, suffix), body, h);
      assert.equal(res.status, 404, `${method} ${suffix} -> ${res.status}`);
    }
    // and nothing changed
    assert.equal((await getWorkflowExecution(env, waiting.workflowExecutionId)).status, 'waiting_for_human');
  });
});

// ---------------------------------------------------------------------------
// 22 — the client cannot control the plan
// ---------------------------------------------------------------------------

test('unknown/forbidden request-body fields are rejected with 400; the client cannot supply steps, capability ids, bindings, execution classes, runtime declarations, identity, or paths', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const wfId = await workflowIdStartingWith(env, IDS.flowA);
    const start = (extra: Record<string, unknown>) => env.server.request('POST', ws(env, `/workflows/${wfId}/executions`), { compilationId: env.compilationId, input: { claim_amount: 15000, payout_amount: 800 }, ...extra });

    for (const field of ['steps', 'capabilityIds', 'capabilityId', 'bindings', 'bindingOverrides', 'executionClass', 'runtimeDeclaration', 'identityId', 'workspaceId', 'path', 'storageKey', 'graph']) {
      const res = await start({ [field]: field === 'steps' ? [{ capabilityId: IDS.hitlC }] : 'x' });
      assert.equal(res.status, 400, `${field} -> ${res.status} ${res.bodyText}`);
      const err = res.json<ErrorWire>().error;
      assert.equal(err.code, 'XO_INVALID_ARGUMENT');
      assert.deepEqual(err.context?.['unknownFields'], [field]);
    }
    // a path/body workflowId mismatch is refused, not "resolved"
    assert.equal((await start({ workflowId: 'wf_other' })).status, 400);
    // nothing was created by any refused request
    assert.equal((await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>().workflowExecutions.length, 0);
    assert.equal((await listExecutions(env)).length, 0);

    // The payload cannot smuggle in a field no step declares (e.g. an attempt to inject the proven-binding value or an unrelated key).
    const smuggle = await start({ input: { claim_amount: 15000, payout_amount: 800, matched: false } });
    assert.equal(smuggle.status, 400);
    assert.match(smuggle.json<ErrorWire>().error.message, /input\.matched/);

    // A valid request derives the plan from the compilation only: exactly the composed two steps, in composed order.
    const ok = await start({});
    assert.equal(ok.status, 201, ok.bodyText);
    assert.deepEqual(ok.json<WorkflowExecutionWire>().steps.map((s) => s.capabilityId), [IDS.flowA, IDS.flowB]);

    // resume rejects unknown fields too
    const wf = ok.json<WorkflowExecutionWire>();
    const resume = await env.server.request('POST', ws(env, `/workflow-executions/${wf.workflowExecutionId}/resume`), { decision: 'approve', capabilityId: IDS.hitlC });
    assert.equal(resume.status, 400);
    // and input must be a bounded plain object
    assert.equal((await start({ input: [1, 2] })).status, 400);
    assert.equal((await env.server.request('POST', ws(env, `/workflows/${wfId}/executions`), { input: {} })).status, 400, 'compilationId is required');
  });
});

test('workflow input is validated against every step\'s declared schema before anything is persisted', async () => {
  await withEnv(async (env) => {
    await approve(env, IDS.flowA);
    await approve(env, IDS.flowB);
    const missing = await startWorkflow(env, IDS.flowA, { claim_amount: 15000 });
    assert.equal(missing.status, 400);
    assert.match(missing.json<ErrorWire>().error.message, /payout_amount/);
    const wrongType = await startWorkflow(env, IDS.flowA, { claim_amount: 'lots', payout_amount: 800 });
    assert.equal(wrongType.status, 400);
    assert.equal((await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>().workflowExecutions.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 23 — permissions / approval, at start AND before every step
// ---------------------------------------------------------------------------

test('required permissions and approvals are enforced fail-closed at start: an unapproved capability, and a contract permission no policy grants, both return 403 and create nothing', async () => {
  await withEnv(async (env) => {
    // not approved
    const unapproved = await startWorkflow(env, IDS.flowA, { claim_amount: 15000, payout_amount: 800 });
    assert.equal(unapproved.status, 403, unapproved.bodyText);
    assert.equal(unapproved.json<ErrorWire>().error.code, 'XO_RUNTIME_PERMISSION_DENIED');
    // only the first step approved: the second still blocks the whole workflow
    await approve(env, IDS.flowA);
    assert.equal((await startWorkflow(env, IDS.flowA, { claim_amount: 15000, payout_amount: 800 })).status, 403);

    // approved, but the contract declares filesystem.read and the (empty) policy grants nothing
    await approve(env, IDS.perm);
    const denied = await startWorkflow(env, IDS.perm, { file_size: 50 });
    assert.equal(denied.status, 403, denied.bodyText);
    assert.match(denied.json<ErrorWire>().error.message, /filesystem\.read/);

    assert.equal((await env.server.request('GET', ws(env, '/workflow-executions'))).json<{ workflowExecutions: unknown[] }>().workflowExecutions.length, 0);
    assert.equal((await listExecutions(env)).length, 0, 'no step ran');
  });
});

test('authorization is re-checked before EVERY step: an approval that disappears while a workflow waits fails the later step closed', async () => {
  await withEnv(async (env) => {
    const waiting = await startHitlChain(env);
    const bId = waiting.steps[1]!.executionId!;
    // Simulate revocation of C's approval on the real filesystem while the workflow is paused.
    const approvalsDir = join(env.dataDir, env.workspace.workspaceId, 'approvals');
    const store = new LocalFsBlobStore(approvalsDir);
    const keys = await store.list();
    assert.ok(keys.ok);
    const cKeys = keys.value.filter((k) => k.includes(IDS.hitlC));
    assert.ok(cKeys.length > 0, `found approval file(s) for C among ${keys.value.join(', ')}`);
    for (const k of cKeys) await rm(join(approvalsDir, k));

    const res = await env.server.request('POST', ws(env, `/workflow-executions/${waiting.workflowExecutionId}/resume`), { decision: 'approve', expectedStepExecutionId: bId });
    assert.equal(res.status, 200, res.bodyText);
    const wf = res.json<WorkflowExecutionWire>();
    assert.equal(wf.status, 'failed');
    assert.equal(wf.errorCode, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.deepEqual(wf.steps.map((s) => s.status), ['succeeded', 'succeeded', 'failed']);
    assert.equal(wf.steps[2]!.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.equal(wf.finalResult, undefined, 'a failed workflow never reports success');
    const c = await getExecution(env, wf.steps[2]!.executionId!);
    assert.equal(c.status, 'failed');
    assert.equal(c.output, undefined, 'the denied step never produced a result');
  });
});

// ---------------------------------------------------------------------------
// Real-fixture customer-value demo: Commercial Property PDF, end to end over the API
// ---------------------------------------------------------------------------

const COMMERCIAL_PROPERTY_PDF = fileURLToPath(new URL('../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf', import.meta.url));

test('DEMO (real fixture): Commercial Property PDF -> compile -> discover -> the one executable workflow starts, waits for a human, resumes and succeeds; its multi-step siblings are honestly rejected', async () => {
  await withTempDir('xo-p08-demo-data-', async (dataDir) => {
    await withTempDir('xo-p08-demo-ws-', async (workspacesDir) => {
      const server = await TestServer.start({ workspaceDataDir: dataDir, workspacesDir });
      try {
        const workspace = (await server.request('POST', '/workspaces', {})).json<WorkspaceRecord>();
        const base = `/workspaces/${workspace.workspaceId}`;
        const pdf = await readFile(COMMERCIAL_PROPERTY_PDF);
        const source = (await server.request('POST', `${base}/sources?filename=policy.pdf`, pdf)).json<{ sourceId: string }>();
        const compiled = (await server.request('POST', `${base}/sources/${source.sourceId}/compile`)).json<{ compilationId: string; status: string }>();
        assert.equal(compiled.status, 'succeeded');

        const { workflows } = (await server.request('GET', `${base}/workflows`)).json<{ workflows: WorkflowViewWire[] }>();
        const statuses = workflows.map((w) => `${w.status}:${w.steps.length}`).sort();
        // Recorded truth about this fixture today: one executable single-step HITL workflow, one
        // 2-step not_executable_yet, one semantically_invalid catch-all whose step count moved from
        // 27 to 30 under Layer 2B (P0.9 Beta, see benchmark/CHANGELOG.md) — active-voice verb-
        // inflection recognition discovering two new genuine capabilities on this same real PDF
        // ("Record in the claim file", "Record before payment authorization", both verified
        // directly against the source PDF's "must be recorded..." obligation sentences).
        assert.deepEqual(statuses, ['executable_candidate:1', 'not_executable_yet:2', 'semantically_invalid:30']);

        // Honest rejection of everything that is not executable.
        for (const w of workflows.filter((x) => x.status !== 'executable_candidate')) {
          const res = await server.request('POST', `${base}/workflows/${w.workflowId}/executions`, { compilationId: compiled.compilationId });
          assert.equal(res.status, 422, `${w.status} -> ${res.status}`);
          assert.equal(res.json<ErrorWire>().error.code, 'XO_WORKFLOW_NOT_EXECUTABLE');
        }

        const runnable = workflows.find((w) => w.status === 'executable_candidate')!;
        assert.equal(runnable.steps[0]!.executionClass, 'human_in_the_loop');
        // Unapproved -> 403; approve -> start.
        assert.equal((await server.request('POST', `${base}/workflows/${runnable.workflowId}/executions`, { compilationId: compiled.compilationId })).status, 403);
        await server.request('POST', `${base}/compilations/${compiled.compilationId}/capabilities/${runnable.steps[0]!.capabilityId}/approve`);
        const startRes = await server.request('POST', `${base}/workflows/${runnable.workflowId}/executions`, { compilationId: compiled.compilationId, input: {} });
        assert.equal(startRes.status, 201, startRes.bodyText);
        const waiting = startRes.json<WorkflowExecutionWire>();
        assert.equal(waiting.status, 'waiting_for_human');
        assert.deepEqual(waiting.steps.map((s) => s.status), ['waiting_for_human']);

        // Single-step workflow: P0.7-compatible resume needs no expectedStepExecutionId.
        const res = await server.request('POST', `${base}/workflow-executions/${waiting.workflowExecutionId}/resume`, { decision: 'approve', data: { note: 'reviewed by underwriter' } });
        assert.equal(res.status, 200, res.bodyText);
        const done = res.json<WorkflowExecutionWire>();
        assert.equal(done.status, 'succeeded');
        assert.equal(done.steps[0]!.executionId, waiting.steps[0]!.executionId);
        assert.equal(done.finalResult?.stepResults[0]?.executionId, waiting.steps[0]!.executionId);
        const exec = (await server.request('GET', `${base}/executions/${done.steps[0]!.executionId}`)).json<ExecutionWire>();
        assert.equal(exec.humanTask?.decision, 'approve');
        assert.equal(exec.output?.status, 'human_confirmed');
        // eslint-disable-next-line no-console
        console.log(`# DEMO workflow ${runnable.workflowId}: ${waiting.status} -> ${done.status} (execution ${done.steps[0]!.executionId})`);
      } finally {
        await server.stop();
      }
    });
  });
});

test('OpenAPI documents all five P0.8 routes, the statuses, expectedStepExecutionId, WORKFLOW_NOT_EXECUTABLE, and the recovery limitations', () => {
  const doc = JSON.stringify(openApiDocument);
  const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
  assert.ok(paths['/workspaces/{workspaceId}/workflows']?.['get']);
  assert.ok(paths['/workspaces/{workspaceId}/workflows/{workflowId}/executions']?.['post']);
  assert.ok(paths['/workspaces/{workspaceId}/workflow-executions']?.['get']);
  assert.ok(paths['/workspaces/{workspaceId}/workflow-executions/{workflowExecutionId}']?.['get']);
  assert.ok(paths['/workspaces/{workspaceId}/workflow-executions/{workflowExecutionId}/resume']?.['post']);
  for (const needle of ['XO_WORKFLOW_NOT_EXECUTABLE', 'expectedStepExecutionId', 'waiting_for_human', 'interrupted', 'skipped', 'exactly-once is NOT provided', 'executable_candidate', 'semantically_invalid']) {
    assert.ok(doc.includes(needle), `OpenAPI should mention "${needle}"`);
  }
});
