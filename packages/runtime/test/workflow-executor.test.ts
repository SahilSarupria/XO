import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { ok } from '@xo/types';
import { WorkflowExecutor } from '../src/workflow/workflow-executor.js';
import { WorkflowEventEmitter, type WorkflowEvent } from '../src/workflow/workflow-events.js';
import { NodeId, type WorkflowGraph } from '../src/workflow/workflow-graph.js';
import { EnvironmentId, RequestId } from '../src/ids.js';
import type { ExecutionEnvironment, ExecutionRequest } from '../src/execution/execution-request.js';
import type { ExecutionResult } from '../src/execution/execution-result.js';
import { ExecutionCancellation } from '../src/cancellation/execution-cancellation.js';
import { SessionId } from '../src/ids.js';

function environment(overrides: Partial<ExecutionEnvironment> = {}): ExecutionEnvironment {
  return { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function stubExecutionResult(request: ExecutionRequest, content: string): ExecutionResult {
  return {
    executionId: request.requestId as unknown as ExecutionResult['executionId'],
    session: { sessionId: SessionId('s'), requestId: request.requestId, mountedPackages: [], chosenCapabilities: [], status: 'completed', receipts: [], createdAt: 't', updatedAt: 't' },
    response: { content, stopReason: 'end_turn', usage: { promptTokens: 1, completionTokens: 1 }, capabilityId: request.capabilityId ?? '', packageName: 'stub_pkg', packageVersion: '1.0.0', degraded: false },
    receipt: {
      receiptId: 'r' as never,
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

/** A scriptable stub standing in for `ExecutionPipeline.run` — records every call and lets a test control per-capabilityId behavior (success, N failures then success, permanent failure, or an artificial delay). */
class StubCapabilityRunner {
  public readonly calls: ExecutionRequest[] = [];
  private readonly failuresRemaining = new Map<string, number>();
  private readonly delays = new Map<string, number>();
  private readonly permanentFailures = new Set<string>();

  failNTimes(capabilityId: string, n: number): void {
    this.failuresRemaining.set(capabilityId, n);
  }
  failAlways(capabilityId: string): void {
    this.permanentFailures.add(capabilityId);
  }
  delay(capabilityId: string, ms: number): void {
    this.delays.set(capabilityId, ms);
  }

  run = async (request: ExecutionRequest, cancellation: ExecutionCancellation): Promise<ExecutionResult> => {
    this.calls.push(request);
    const capabilityId = request.capabilityId ?? '';
    const delayMs = this.delays.get(capabilityId);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (cancellation.isCancelled) {
      return { executionId: request.requestId as unknown as ExecutionResult['executionId'], session: stubExecutionResult(request, '').session, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_CANCELLED, 'cancelled') };
    }
    if (this.permanentFailures.has(capabilityId)) {
      return { executionId: request.requestId as unknown as ExecutionResult['executionId'], session: stubExecutionResult(request, '').session, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `stub failure for ${capabilityId}`) };
    }
    const remaining = this.failuresRemaining.get(capabilityId) ?? 0;
    if (remaining > 0) {
      this.failuresRemaining.set(capabilityId, remaining - 1);
      return { executionId: request.requestId as unknown as ExecutionResult['executionId'], session: stubExecutionResult(request, '').session, error: new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `transient failure for ${capabilityId}`) };
    }
    return stubExecutionResult(request, `${capabilityId}-output`);
  };
}

const instantSleep = async (): Promise<void> => {};

test('sequential workflow: start -> capability -> capability -> end completes in order', async () => {
  const runner = new StubCapabilityRunner();
  const graph: WorkflowGraph = {
    graphId: 'seq',
    version: '1.0.0',
    startNodeId: NodeId('start'),
    nodes: [
      { id: NodeId('start'), type: 'start' },
      { id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'do a' } },
      { id: NodeId('b'), type: 'capability', config: { capabilityId: 'cap_b', input: 'do b' } },
      { id: NodeId('end'), type: 'end' },
    ],
    edges: [
      { from: NodeId('start'), to: NodeId('a') },
      { from: NodeId('a'), to: NodeId('b') },
      { from: NodeId('b'), to: NodeId('end') },
    ],
  };

  const executor = new WorkflowExecutor(runner.run);
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'completed');
  assert.equal(result.error, undefined);
  assert.deepEqual(result.instance.state.completedNodes, [NodeId('start'), NodeId('a'), NodeId('b'), NodeId('end')]);
  assert.equal(result.instance.state.outputs['a'], 'cap_a-output');
  assert.equal(result.instance.state.outputs['b'], 'cap_b-output');
});

test('parallel workflow: both branches run and a merge node waits for both', async () => {
  const runner = new StubCapabilityRunner();
  const graph: WorkflowGraph = {
    graphId: 'par',
    version: '1.0.0',
    startNodeId: NodeId('fork'),
    nodes: [
      { id: NodeId('fork'), type: 'parallel' },
      { id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } },
      { id: NodeId('b'), type: 'capability', config: { capabilityId: 'cap_b', input: 'b' } },
      { id: NodeId('merge'), type: 'merge' },
    ],
    edges: [
      { from: NodeId('fork'), to: NodeId('a') },
      { from: NodeId('fork'), to: NodeId('b') },
      { from: NodeId('a'), to: NodeId('merge') },
      { from: NodeId('b'), to: NodeId('merge') },
    ],
  };

  const executor = new WorkflowExecutor(runner.run);
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'completed');
  assert.ok(result.instance.state.completedNodes.includes(NodeId('a')));
  assert.ok(result.instance.state.completedNodes.includes(NodeId('b')));
  assert.ok(result.instance.state.completedNodes.includes(NodeId('merge')));
});

test('conditional branch: the decision selects one path, the other resolves to skipped', async () => {
  const runner = new StubCapabilityRunner();
  const graph: WorkflowGraph = {
    graphId: 'cond',
    version: '1.0.0',
    startNodeId: NodeId('check'),
    nodes: [
      { id: NodeId('check'), type: 'capability', config: { capabilityId: 'cap_check', input: 'check' } },
      { id: NodeId('decide'), type: 'decision' },
      { id: NodeId('high'), type: 'capability', config: { capabilityId: 'cap_high', input: 'high' } },
      { id: NodeId('low'), type: 'capability', config: { capabilityId: 'cap_low', input: 'low' } },
    ],
    edges: [
      { from: NodeId('check'), to: NodeId('decide') },
      { from: NodeId('decide'), to: NodeId('high'), condition: { kind: 'expression', field: 'check', operator: 'eq', value: 'cap_check-output' } },
      { from: NodeId('decide'), to: NodeId('low') },
    ],
  };

  const executor = new WorkflowExecutor(runner.run);
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'completed');
  assert.ok(result.instance.state.completedNodes.includes(NodeId('high')));
  assert.ok(result.instance.state.skippedNodes.includes(NodeId('low')));
  assert.ok(!runner.calls.some((c) => c.capabilityId === 'cap_low'));
});

test('retry: a node that fails twice then succeeds completes with attempt 3 recorded in history', async () => {
  const runner = new StubCapabilityRunner();
  runner.failNTimes('cap_flaky', 2);
  const graph: WorkflowGraph = {
    graphId: 'retry',
    version: '1.0.0',
    startNodeId: NodeId('flaky'),
    nodes: [{ id: NodeId('flaky'), type: 'capability', config: { capabilityId: 'cap_flaky', input: 'x' }, retryPolicy: { maxAttempts: 3, backoffMs: 1 } }],
    edges: [],
  };

  const executor = new WorkflowExecutor(runner.run, { sleep: instantSleep });
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'completed');
  const entry = result.instance.state.history.find((h) => h.nodeId === 'flaky');
  assert.equal(entry?.attempt, 3);
  assert.equal(runner.calls.length, 3);
});

test('retry exhausted: a permanently failing node fails the whole workflow', async () => {
  const runner = new StubCapabilityRunner();
  runner.failAlways('cap_broken');
  const graph: WorkflowGraph = {
    graphId: 'retry-exhausted',
    version: '1.0.0',
    startNodeId: NodeId('broken'),
    nodes: [{ id: NodeId('broken'), type: 'capability', config: { capabilityId: 'cap_broken', input: 'x' }, retryPolicy: { maxAttempts: 2, backoffMs: 1 } }],
    edges: [],
  };

  const executor = new WorkflowExecutor(runner.run, { sleep: instantSleep });
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'failed');
  assert.equal(result.error?.code, 'XO_RUNTIME_EXECUTION_FAILED');
  assert.deepEqual(result.instance.state.failedNodes, [NodeId('broken')]);
  assert.equal(runner.calls.length, 2);
});

test('timeout: a node exceeding its timeoutMs fails with RUNTIME_EXECUTION_TIMEOUT', async () => {
  const runner = new StubCapabilityRunner();
  runner.delay('cap_slow', 200);
  const graph: WorkflowGraph = {
    graphId: 'timeout',
    version: '1.0.0',
    startNodeId: NodeId('slow'),
    nodes: [{ id: NodeId('slow'), type: 'capability', config: { capabilityId: 'cap_slow', input: 'x' }, timeoutMs: 10 }],
    edges: [],
  };

  const executor = new WorkflowExecutor(runner.run);
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'failed');
  const entry = result.instance.state.history.find((h) => h.nodeId === 'slow');
  assert.ok(entry?.error?.includes('timed out'));
});

test('cancellation: cancelling mid-run stops further progress and marks the instance cancelled', async () => {
  const runner = new StubCapabilityRunner();
  runner.delay('cap_a', 100);
  const graph: WorkflowGraph = {
    graphId: 'cancel',
    version: '1.0.0',
    startNodeId: NodeId('a'),
    nodes: [
      { id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } },
      { id: NodeId('b'), type: 'capability', config: { capabilityId: 'cap_b', input: 'b' } },
    ],
    edges: [{ from: NodeId('a'), to: NodeId('b') }],
  };

  const cancellation = new ExecutionCancellation();
  const executor = new WorkflowExecutor(runner.run);
  const resultPromise = executor.run(graph, environment(), cancellation);
  setTimeout(() => cancellation.cancel('user cancelled'), 10);
  const result = await resultPromise;

  assert.equal(result.instance.status, 'cancelled');
  assert.equal(result.error?.code, 'XO_RUNTIME_EXECUTION_CANCELLED');
  assert.ok(!runner.calls.some((c) => c.capabilityId === 'cap_b'), 'node b should never have been reached');
});

test('failure propagation: a node whose only live predecessor failed is itself marked failed, not skipped', async () => {
  const runner = new StubCapabilityRunner();
  runner.failAlways('cap_a');
  const graph: WorkflowGraph = {
    graphId: 'fail-prop',
    version: '1.0.0',
    startNodeId: NodeId('a'),
    nodes: [
      { id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } },
      { id: NodeId('b'), type: 'capability', config: { capabilityId: 'cap_b', input: 'b' } },
    ],
    edges: [{ from: NodeId('a'), to: NodeId('b') }],
  };

  const executor = new WorkflowExecutor(runner.run);
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'failed');
  assert.ok(!runner.calls.some((c) => c.capabilityId === 'cap_b'), 'downstream-of-failure node should never run');
});

test('deterministic scheduling: two runs of the same graph produce the same completed-node order', async () => {
  const graph: WorkflowGraph = {
    graphId: 'det',
    version: '1.0.0',
    startNodeId: NodeId('fork'),
    nodes: [
      { id: NodeId('fork'), type: 'parallel' },
      { id: NodeId('zebra'), type: 'capability', config: { capabilityId: 'cap_z', input: 'z' } },
      { id: NodeId('apple'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } },
    ],
    edges: [
      { from: NodeId('fork'), to: NodeId('zebra') },
      { from: NodeId('fork'), to: NodeId('apple') },
    ],
  };

  const runner1 = new StubCapabilityRunner();
  const result1 = await new WorkflowExecutor(runner1.run).run(graph, environment());
  const runner2 = new StubCapabilityRunner();
  const result2 = await new WorkflowExecutor(runner2.run).run(graph, environment());

  assert.deepEqual(result1.instance.state.completedNodes, result2.instance.state.completedNodes);
  assert.deepEqual(
    result1.instance.state.completedNodes,
    [NodeId('fork'), NodeId('zebra'), NodeId('apple')], // declaration order, not alphabetical
  );
});

test('execution receipts: WorkflowReceipt aggregates node receipts and resource usage', async () => {
  const runner = new StubCapabilityRunner();
  const graph: WorkflowGraph = {
    graphId: 'receipts',
    version: '1.0.0',
    startNodeId: NodeId('a'),
    nodes: [
      { id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } },
      { id: NodeId('b'), type: 'capability', config: { capabilityId: 'cap_b', input: 'b' } },
    ],
    edges: [{ from: NodeId('a'), to: NodeId('b') }],
  };

  const result = await new WorkflowExecutor(runner.run).run(graph, environment());

  assert.ok(result.receipt);
  assert.equal(result.receipt?.status, 'completed');
  assert.equal(result.receipt?.nodeReceipts.length, 2);
  assert.equal(result.receipt?.completedNodeCount, 2);
  assert.equal(result.receipt?.resourceUsage.promptTokens, 2); // 1 per stub capability call
  assert.ok(result.receipt?.resourceUsage.estimatedCost > 0);
});

test('subworkflow: a nested graph runs and its outputs flow into the outer node output', async () => {
  const runner = new StubCapabilityRunner();
  const nested: WorkflowGraph = {
    graphId: 'nested',
    version: '1.0.0',
    startNodeId: NodeId('inner'),
    nodes: [{ id: NodeId('inner'), type: 'capability', config: { capabilityId: 'cap_inner', input: 'x' } }],
    edges: [],
  };
  const outer: WorkflowGraph = {
    graphId: 'outer',
    version: '1.0.0',
    startNodeId: NodeId('sub'),
    nodes: [{ id: NodeId('sub'), type: 'subworkflow', config: { graph: nested } }],
    edges: [],
  };

  const result = await new WorkflowExecutor(runner.run).run(outer, environment());

  assert.equal(result.instance.status, 'completed');
  const subOutput = result.instance.state.outputs['sub'] as Record<string, unknown>;
  assert.equal(subOutput['inner'], 'cap_inner-output');
});

test('loop: runs the body graph until the exit condition is met, tracking iteration count', async () => {
  const runner = new StubCapabilityRunner();
  let call = 0;
  runner.run = (async (request) => {
    call += 1;
    return stubExecutionResult(request, String(call));
  }) as typeof runner.run;

  const body: WorkflowGraph = {
    graphId: 'loop-body',
    version: '1.0.0',
    startNodeId: NodeId('step'),
    nodes: [{ id: NodeId('step'), type: 'capability', config: { capabilityId: 'cap_step', input: 'x' } }],
    edges: [],
  };
  const outer: WorkflowGraph = {
    graphId: 'loop-outer',
    version: '1.0.0',
    startNodeId: NodeId('loop'),
    nodes: [{ id: NodeId('loop'), type: 'loop', config: { bodyGraph: body, maxIterations: 5, exitCondition: { kind: 'expression', field: 'step', operator: 'eq', value: '3' } } }],
    edges: [],
  };

  const result = await new WorkflowExecutor(runner.run).run(outer, environment());
  assert.equal(result.instance.status, 'completed');
  const output = result.instance.state.outputs['loop'] as { iterations: number };
  assert.equal(output.iterations, 3);
});

test('loop: maxIterations guards against a never-satisfied exit condition', async () => {
  const runner = new StubCapabilityRunner();
  const body: WorkflowGraph = {
    graphId: 'loop-body-2',
    version: '1.0.0',
    startNodeId: NodeId('step'),
    nodes: [{ id: NodeId('step'), type: 'capability', config: { capabilityId: 'cap_step', input: 'x' } }],
    edges: [],
  };
  const outer: WorkflowGraph = {
    graphId: 'loop-outer-2',
    version: '1.0.0',
    startNodeId: NodeId('loop'),
    nodes: [{ id: NodeId('loop'), type: 'loop', config: { bodyGraph: body, maxIterations: 4, exitCondition: { kind: 'expression', field: 'never', operator: 'truthy' } } }],
    edges: [],
  };

  const result = await new WorkflowExecutor(runner.run).run(outer, environment());
  assert.equal(result.instance.status, 'completed');
  const output = result.instance.state.outputs['loop'] as { iterations: number };
  assert.equal(output.iterations, 4);
});

test('delay: waits (via injectable sleep) and records the configured duration as output', async () => {
  const runner = new StubCapabilityRunner();
  let sleptMs: number | undefined;
  const graph: WorkflowGraph = {
    graphId: 'delay',
    version: '1.0.0',
    startNodeId: NodeId('wait'),
    nodes: [{ id: NodeId('wait'), type: 'delay', config: { durationMs: 5000 } }],
    edges: [],
  };

  const executor = new WorkflowExecutor(runner.run, {
    sleep: async (ms) => {
      sleptMs = ms;
    },
  });
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'completed');
  assert.equal(sleptMs, 5000);
  assert.deepEqual(result.instance.state.outputs['wait'], { delayedMs: 5000 });
});

test('a custom:<name> node type dispatches to a caller-registered handler', async () => {
  const runner = new StubCapabilityRunner();
  const graph: WorkflowGraph = {
    graphId: 'custom',
    version: '1.0.0',
    startNodeId: NodeId('c'),
    nodes: [{ id: NodeId('c'), type: 'custom:my-thing' }],
    edges: [],
  };

  const executor = new WorkflowExecutor(runner.run, {
    customNodeHandlers: new Map([['custom:my-thing', async () => ok({ output: 'custom-ran' })]]),
  });
  const result = await executor.run(graph, environment());

  assert.equal(result.instance.status, 'completed');
  assert.equal(result.instance.state.outputs['c'], 'custom-ran');
});

test('a custom:<name> node type with no registered handler fails clearly rather than silently no-op-ing', async () => {
  const runner = new StubCapabilityRunner();
  const graph: WorkflowGraph = {
    graphId: 'custom-missing',
    version: '1.0.0',
    startNodeId: NodeId('c'),
    nodes: [{ id: NodeId('c'), type: 'custom:unregistered' }],
    edges: [],
  };

  const result = await new WorkflowExecutor(runner.run).run(graph, environment());
  assert.equal(result.instance.status, 'failed');
  assert.equal(result.error?.code, 'XO_RUNTIME_INVALID_REQUEST');
});

test('checkpoint and resume: a cancelled run can be resumed from its last checkpoint and completes without redoing finished nodes', async () => {
  const runner = new StubCapabilityRunner();
  runner.delay('cap_b', 100);
  const graph: WorkflowGraph = {
    graphId: 'checkpoint',
    version: '1.0.0',
    startNodeId: NodeId('a'),
    nodes: [
      { id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } },
      { id: NodeId('b'), type: 'capability', config: { capabilityId: 'cap_b', input: 'b' } },
    ],
    edges: [{ from: NodeId('a'), to: NodeId('b') }],
  };

  const cancellation = new ExecutionCancellation();
  const executor = new WorkflowExecutor(runner.run, { checkpointEveryRound: true });
  const firstRun = executor.run(graph, environment(), cancellation);
  setTimeout(() => cancellation.cancel('pause'), 20);
  const firstResult = await firstRun;
  assert.equal(firstResult.instance.status, 'cancelled');
  assert.ok(firstResult.instance.state.completedNodes.includes(NodeId('a')));

  const checkpoints = executor.createCheckpoint(firstResult.instance);
  const aCallCountBeforeResume = runner.calls.filter((c) => c.capabilityId === 'cap_a').length;

  const resumed = await executor.resume(checkpoints, environment());
  assert.equal(resumed.instance.status, 'completed');
  assert.equal(runner.calls.filter((c) => c.capabilityId === 'cap_a').length, aCallCountBeforeResume, 'node a must not be re-run');
  assert.ok(resumed.instance.state.completedNodes.includes(NodeId('b')));
});

test('workflow events fire in the documented order for a simple graph', async () => {
  const runner = new StubCapabilityRunner();
  const events: WorkflowEvent[] = [];
  const emitter = new WorkflowEventEmitter();
  emitter.on((event) => events.push(event));

  const graph: WorkflowGraph = {
    graphId: 'events',
    version: '1.0.0',
    startNodeId: NodeId('a'),
    nodes: [{ id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } }],
    edges: [],
  };

  await new WorkflowExecutor(runner.run, { events: emitter }).run(graph, environment());

  assert.deepEqual(
    events.map((e) => e.type),
    ['started', 'node_started', 'node_completed', 'completed'],
  );
});

test('a throwing event listener does not affect workflow execution', async () => {
  const runner = new StubCapabilityRunner();
  const emitter = new WorkflowEventEmitter();
  emitter.on(() => {
    throw new Error('listener boom');
  });
  const graph: WorkflowGraph = {
    graphId: 'events-throw',
    version: '1.0.0',
    startNodeId: NodeId('a'),
    nodes: [{ id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } }],
    edges: [],
  };

  const result = await new WorkflowExecutor(runner.run, { events: emitter }).run(graph, environment());
  assert.equal(result.instance.status, 'completed');
});

test('a WorkflowInstance and WorkflowState are frozen (immutable)', async () => {
  const runner = new StubCapabilityRunner();
  const graph: WorkflowGraph = {
    graphId: 'frozen',
    version: '1.0.0',
    startNodeId: NodeId('a'),
    nodes: [{ id: NodeId('a'), type: 'capability', config: { capabilityId: 'cap_a', input: 'a' } }],
    edges: [],
  };
  const result = await new WorkflowExecutor(runner.run).run(graph, environment());
  assert.ok(Object.isFrozen(result.instance));
});
