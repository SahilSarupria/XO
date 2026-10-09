import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { WorkflowExecutor } from '../src/workflow/workflow-executor.js';
import { InMemoryRuntimeStore } from '../src/persistence/in-memory-runtime-store.js';
import { FileRuntimeStore } from '../src/persistence/file/file-runtime-store.js';
import type { RuntimeStore } from '../src/persistence/runtime-store.interface.js';
import { NodeId, type WorkflowGraph } from '../src/workflow/workflow-graph.js';
import { EnvironmentId, SessionId, WorkflowInstanceId } from '../src/ids.js';
import type { ExecutionEnvironment, ExecutionRequest } from '../src/execution/execution-request.js';
import type { ExecutionResult } from '../src/execution/execution-result.js';
import { ExecutionCancellation } from '../src/cancellation/execution-cancellation.js';

function environment(): ExecutionEnvironment {
  return { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: '2026-01-01T00:00:00.000Z' };
}

function stubExecutionResult(request: ExecutionRequest, content: string): ExecutionResult {
  return {
    executionId: request.requestId as unknown as ExecutionResult['executionId'],
    session: { sessionId: SessionId('s'), requestId: request.requestId, mountedPackages: [], chosenCapabilities: [], status: 'completed', receipts: [], createdAt: 't', updatedAt: 't' },
    response: { content, stopReason: 'end_turn', usage: { promptTokens: 1, completionTokens: 1 }, capabilityId: request.capabilityId ?? '', packageName: 'stub_pkg', packageVersion: '1.0.0', degraded: false },
    receipt: {
      receiptId: `r_${request.requestId}` as never,
      requestId: request.requestId,
      planId: 'p' as never,
      packagesUsed: [{ name: 'stub_pkg', version: '1.0.0' }],
      componentHashes: [],
      capabilitiesInvoked: [request.capabilityId ?? ''],
      executionDurationMs: 1,
      tokenUsage: { promptTokens: 1, completionTokens: 1 },
      validationResults: { valid: true, issues: [] },
      errors: [],
      createdAt: 't',
      estimatedCost: { currency: 'USD', amount: 0.001 },
      degraded: false,
    },
  };
}

/** Counts calls per capabilityId across however many `WorkflowExecutor` instances share it — the key thing a restart/resume test needs to verify "no rerun". */
class CallCountingRunner {
  public readonly callCountByCapability = new Map<string, number>();
  /** Per-capability delay, so a test can make e.g. only node "b" slow while node "a" completes quickly — a single global delay would make the *first* node slow too, defeating "interrupt while node b is in flight, after node a already finished". */
  public readonly delayByCapability = new Map<string, number>();
  public failCapability: string | undefined;
  /** Called synchronously the instant a capability is invoked, before its delay — lets a test trigger cancellation deterministically (e.g. "cancel the moment node b starts") instead of racing wall-clock `setTimeout`s against genuine disk I/O, which this store's tests otherwise do plenty of. */
  public onCall: ((capabilityId: string) => void) | undefined;

  run = async (request: ExecutionRequest, cancellation: ExecutionCancellation): Promise<ExecutionResult> => {
    const capabilityId = request.capabilityId ?? '';
    this.callCountByCapability.set(capabilityId, (this.callCountByCapability.get(capabilityId) ?? 0) + 1);
    this.onCall?.(capabilityId);
    const delayMs = this.delayByCapability.get(capabilityId) ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (cancellation.isCancelled) {
      return { executionId: request.requestId as unknown as ExecutionResult['executionId'], session: stubExecutionResult(request, '').session, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_CANCELLED, 'cancelled') };
    }
    if (this.failCapability === capabilityId) {
      return { executionId: request.requestId as unknown as ExecutionResult['executionId'], session: stubExecutionResult(request, '').session, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, 'stub failure') };
    }
    return stubExecutionResult(request, `${capabilityId}-done`);
  };
}

function sequentialGraph(graphId: string, capabilityIds: readonly string[]): WorkflowGraph {
  const nodes = capabilityIds.map((id) => ({ id: NodeId(id), type: 'capability' as const, config: { capabilityId: id, input: id } }));
  const edges = capabilityIds.slice(1).map((id, i) => ({ from: NodeId(capabilityIds[i]!), to: NodeId(id) }));
  return { graphId, version: '1.0.0', startNodeId: NodeId(capabilityIds[0]!), nodes, edges };
}

const instantSleep = async (): Promise<void> => {};

test('in-memory behavior is unchanged when no store is configured', async () => {
  const runner = new CallCountingRunner();
  const graph = sequentialGraph('no-store', ['a', 'b']);
  const executor = new WorkflowExecutor(runner.run);
  const result = await executor.run(graph, environment());
  assert.equal(result.instance.status, 'completed');
  assert.equal(result.instance.state.outputs['a'], 'a-done');
});

test('execution state persists to the configured store after each round', async () => {
  const runner = new CallCountingRunner();
  const store = new InMemoryRuntimeStore();
  const graph = sequentialGraph('persist-rounds', ['a', 'b']);
  const executor = new WorkflowExecutor(runner.run, { store });

  const result = await executor.run(graph, environment());
  assert.equal(result.instance.status, 'completed');

  const persisted = await store.executions.get(result.workflowInstanceId);
  assert.ok(persisted.ok && persisted.value);
  assert.equal(persisted.value?.data.instance.status, 'completed');
  assert.deepEqual(persisted.value?.data.instance.state.completedNodes, result.instance.state.completedNodes);
});

test('receipts persist to the store on successful completion', async () => {
  const runner = new CallCountingRunner();
  const store = new InMemoryRuntimeStore();
  const graph = sequentialGraph('persist-receipts', ['a', 'b']);
  const executor = new WorkflowExecutor(runner.run, { store });

  const result = await executor.run(graph, environment());
  const byExecution = await store.receipts.listByExecution(result.workflowInstanceId);
  assert.ok(byExecution.ok);
  if (byExecution.ok) {
    assert.ok(byExecution.value.some((r) => r.data.kind === 'workflow'));
    assert.equal(byExecution.value.filter((r) => r.data.kind === 'execution').length, 2);
  }
});

test('failure state persists: a failed execution is recorded as failed, not silently lost', async () => {
  const runner = new CallCountingRunner();
  runner.failCapability = 'b';
  const store = new InMemoryRuntimeStore();
  const graph = sequentialGraph('persist-failure', ['a', 'b']);
  const executor = new WorkflowExecutor(runner.run, { store });

  const result = await executor.run(graph, environment());
  assert.equal(result.instance.status, 'failed');

  const persisted = await store.executions.get(result.workflowInstanceId);
  assert.ok(persisted.ok && persisted.value);
  assert.equal(persisted.value?.data.instance.status, 'failed');
  assert.deepEqual(persisted.value?.data.instance.state.failedNodes, [NodeId('b')]);
});

test('cancellation state persists: a cancelled execution is recorded as cancelled, not failed', async () => {
  const runner = new CallCountingRunner();
  runner.delayByCapability.set('a', 100);
  const store = new InMemoryRuntimeStore();
  const graph = sequentialGraph('persist-cancel', ['a']);
  const executor = new WorkflowExecutor(runner.run, { store });

  const cancellation = new ExecutionCancellation();
  const resultPromise = executor.run(graph, environment(), cancellation);
  setTimeout(() => cancellation.cancel('test'), 10);
  const result = await resultPromise;
  assert.equal(result.instance.status, 'cancelled');

  const persisted = await store.executions.get(result.workflowInstanceId);
  assert.ok(persisted.ok && persisted.value);
  assert.equal(persisted.value?.data.instance.status, 'cancelled', 'terminal cancelled status, not "failed", must be durably recorded');
});

test('retry attempt information (history) survives persistence', async () => {
  const runner = new CallCountingRunner();
  const store = new InMemoryRuntimeStore();
  const graph: WorkflowGraph = {
    graphId: 'persist-retry',
    version: '1.0.0',
    startNodeId: NodeId('flaky'),
    nodes: [{ id: NodeId('flaky'), type: 'capability', config: { capabilityId: 'flaky', input: 'x' }, retryPolicy: { maxAttempts: 3, backoffMs: 1 } }],
    edges: [],
  };
  let attempt = 0;
  runner.run = (async (request: ExecutionRequest) => {
    attempt += 1;
    if (attempt < 3) return { executionId: request.requestId as unknown as ExecutionResult['executionId'], session: stubExecutionResult(request, '').session, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, 'transient') };
    return stubExecutionResult(request, 'ok');
  }) as typeof runner.run;

  const executor = new WorkflowExecutor(runner.run, { store, sleep: instantSleep });
  const result = await executor.run(graph, environment());
  assert.equal(result.instance.status, 'completed');

  const persisted = await store.executions.get(result.workflowInstanceId);
  const historyEntry = persisted.ok && persisted.value?.data.instance.state.history.find((h) => h.nodeId === 'flaky');
  assert.equal(historyEntry && historyEntry.attempt, 3);
});

test('checkpointEveryRound persists checkpoints to the store, in addition to the in-memory checkpoint store', async () => {
  const runner = new CallCountingRunner();
  const store = new InMemoryRuntimeStore();
  const graph = sequentialGraph('persist-checkpoints', ['a', 'b']);
  const executor = new WorkflowExecutor(runner.run, { store, checkpointEveryRound: true });

  const result = await executor.run(graph, environment());
  const checkpoints = await store.checkpoints.listForExecution(result.workflowInstanceId);
  assert.ok(checkpoints.ok);
  if (checkpoints.ok) assert.ok(checkpoints.value.length >= 2, 'expected at least one checkpoint per round');
});

test('resumeFromStore fails clearly when nothing was ever persisted for the given execution id', async () => {
  const store = new InMemoryRuntimeStore();
  const runner = new CallCountingRunner();
  const executor = new WorkflowExecutor(runner.run, { store });
  const result = await executor.resumeFromStore(WorkflowInstanceId('never-existed'), environment());
  assert.equal(result.ok, false);
});

test('resumeFromStore without a store configured fails clearly rather than throwing', async () => {
  const runner = new CallCountingRunner();
  const executor = new WorkflowExecutor(runner.run);
  const result = await executor.resumeFromStore(WorkflowInstanceId('whatever'), environment());
  assert.equal(result.ok, false);
});

test('resumeFromStore falls back to the raw execution record when no checkpoint was ever taken', async () => {
  const store = new InMemoryRuntimeStore();
  const runner = new CallCountingRunner();
  runner.delayByCapability.set('b', 100);
  const graph = sequentialGraph('resume-no-checkpoint', ['a', 'b']);
  const executorA = new WorkflowExecutor(runner.run, { store }); // checkpointEveryRound NOT set — only execution-state persistence happens

  const cancellation = new ExecutionCancellation();
  const partial = executorA.run(graph, environment(), cancellation);
  setTimeout(() => cancellation.cancel('pause'), 10);
  const partialResult = await partial;
  assert.equal(partialResult.instance.status, 'cancelled');

  const noCheckpoints = await store.checkpoints.listForExecution(partialResult.workflowInstanceId);
  assert.equal(noCheckpoints.ok && noCheckpoints.value.length, 0, 'sanity: no checkpoint was ever taken');

  const executorB = new WorkflowExecutor(runner.run, { store });
  const resumed = await executorB.resumeFromStore(partialResult.workflowInstanceId, environment());
  assert.ok(resumed.ok);
  if (resumed.ok) assert.equal(resumed.value.instance.status, 'completed');
});

// --- The real restart simulation the brief explicitly asks for ---

test('restart simulation: Executor A persists partial progress, is destroyed, Executor B loads and resumes to completion without rerunning completed nodes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-restart-'));
  try {
    const runner = new CallCountingRunner();
    runner.delayByCapability.set('b', 300); // gives the cancellation below time to land while b is genuinely still in flight
    const graph = sequentialGraph('restart-sim', ['a', 'b', 'c']);

    // --- process A ---
    const storeA: RuntimeStore = new FileRuntimeStore({ rootDir: dir });
    const executorA = new WorkflowExecutor(runner.run, { store: storeA });
    const cancellation = new ExecutionCancellation();
    // Deterministic, not timing-based: cancel the instant node "b" starts.
    // By construction of a sequential a->b->c graph, "b" only ever starts
    // after "a" has already completed, folded, and been persisted — so
    // this reliably interrupts mid-workflow without racing wall-clock
    // `setTimeout`s against this store's real (and, in this sandbox,
    // sometimes slow) disk I/O.
    runner.onCall = (capabilityId) => {
      if (capabilityId === 'b') cancellation.cancel('process terminating');
    };
    const partialResult = await executorA.run(graph, environment(), cancellation);

    assert.equal(partialResult.instance.status, 'cancelled');
    assert.ok(partialResult.instance.state.completedNodes.includes(NodeId('a')), 'node a should have completed before the interruption');
    assert.equal(runner.callCountByCapability.get('a'), 1);
    assert.equal(runner.callCountByCapability.get('c') ?? 0, 0, 'node c must never have started');

    // "process terminates" — nothing more happens with executorA/storeA;
    // a brand new store instance pointed at the same directory stands in
    // for a fresh process reading what was left on disk.
    runner.onCall = undefined;

    // --- process B ---
    const storeB: RuntimeStore = new FileRuntimeStore({ rootDir: dir });
    const executorB = new WorkflowExecutor(runner.run, { store: storeB });
    const resumed = await executorB.resumeFromStore(partialResult.workflowInstanceId, environment());

    assert.ok(resumed.ok);
    if (!resumed.ok) return;
    assert.equal(resumed.value.instance.status, 'completed');
    assert.deepEqual(resumed.value.instance.state.completedNodes, [NodeId('a'), NodeId('b'), NodeId('c')]);
    assert.equal(resumed.value.instance.state.outputs['a'], 'a-done');
    assert.equal(resumed.value.instance.state.outputs['b'], 'b-done');
    assert.equal(resumed.value.instance.state.outputs['c'], 'c-done');

    // The whole point: node "a" (already completed before the crash) must
    // not have been re-run. Node "b" is legitimately called *twice* —
    // once in process A (interrupted mid-flight, never completed, so it
    // doesn't count as "rerunning completed work") and once more in
    // process B, where it actually finishes — this is exactly the
    // documented at-least-once semantics, not a bug.
    assert.equal(runner.callCountByCapability.get('a'), 1, 'node a must not be rerun after resume');
    assert.equal(runner.callCountByCapability.get('b'), 2, 'node b was interrupted before completing in process A, so a retry in process B is expected (at-least-once)');
    assert.equal(runner.callCountByCapability.get('c'), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('restart simulation via an explicit checkpoint (checkpointEveryRound) also resumes without rerunning completed work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-restart-checkpoint-'));
  try {
    const runner = new CallCountingRunner();
    runner.delayByCapability.set('b', 300);
    const graph = sequentialGraph('restart-sim-checkpoint', ['a', 'b']);

    const storeA: RuntimeStore = new FileRuntimeStore({ rootDir: dir });
    const executorA = new WorkflowExecutor(runner.run, { store: storeA, checkpointEveryRound: true });
    const cancellation = new ExecutionCancellation();
    runner.onCall = (capabilityId) => {
      if (capabilityId === 'b') cancellation.cancel('process terminating');
    };
    const partialResult = await executorA.run(graph, environment(), cancellation);
    assert.equal(partialResult.instance.status, 'cancelled');
    runner.onCall = undefined;

    const checkpoints = await storeA.checkpoints.listForExecution(partialResult.workflowInstanceId);
    assert.ok(checkpoints.ok && checkpoints.value.length >= 1, 'at least one checkpoint should have been taken before the interruption');

    const storeB: RuntimeStore = new FileRuntimeStore({ rootDir: dir });
    const executorB = new WorkflowExecutor(runner.run, { store: storeB });
    const resumed = await executorB.resumeFromStore(partialResult.workflowInstanceId, environment());
    assert.ok(resumed.ok);
    if (resumed.ok) {
      assert.equal(resumed.value.instance.status, 'completed');
      assert.equal(runner.callCountByCapability.get('a'), 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('determinism: resuming the same persisted checkpoint from independent executors produces the same completed-node order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'xo-runtime-determinism-'));
  try {
    const runner1 = new CallCountingRunner();
    runner1.delayByCapability.set('b', 300);
    const graph = sequentialGraph('determinism', ['a', 'b', 'c']);
    const store1: RuntimeStore = new FileRuntimeStore({ rootDir: join(dir, 'run1') });
    const executor1 = new WorkflowExecutor(runner1.run, { store: store1 });
    const cancellation1 = new ExecutionCancellation();
    runner1.onCall = (capabilityId) => {
      if (capabilityId === 'b') cancellation1.cancel('x');
    };
    const partialResult1 = await executor1.run(graph, environment(), cancellation1);
    runner1.onCall = undefined;
    const resumeExecutor1 = new WorkflowExecutor(runner1.run, { store: store1 });
    const resumed1 = await resumeExecutor1.resumeFromStore(partialResult1.workflowInstanceId, environment());

    const runner2 = new CallCountingRunner();
    runner2.delayByCapability.set('b', 300);
    const store2: RuntimeStore = new FileRuntimeStore({ rootDir: join(dir, 'run2') });
    const executor2 = new WorkflowExecutor(runner2.run, { store: store2 });
    const cancellation2 = new ExecutionCancellation();
    runner2.onCall = (capabilityId) => {
      if (capabilityId === 'b') cancellation2.cancel('x');
    };
    const partialResult2 = await executor2.run(graph, environment(), cancellation2);
    runner2.onCall = undefined;
    const resumeExecutor2 = new WorkflowExecutor(runner2.run, { store: store2 });
    const resumed2 = await resumeExecutor2.resumeFromStore(partialResult2.workflowInstanceId, environment());

    assert.ok(resumed1.ok && resumed2.ok);
    if (resumed1.ok && resumed2.ok) {
      assert.deepEqual(resumed1.value.instance.state.completedNodes, resumed2.value.instance.state.completedNodes);
      assert.deepEqual(resumed1.value.instance.state.outputs, resumed2.value.instance.state.outputs);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
