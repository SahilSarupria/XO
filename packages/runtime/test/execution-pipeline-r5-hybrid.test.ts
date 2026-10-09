import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok } from '@xo/types';
import type { CapabilityDeclaration, CapabilityInputSchema, HybridExecutionStep } from '@xo/types';
import { PermissionManager, RuleBasedPolicy, Permissions } from '@xo/permissions';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import { deriveExecutionId } from '../src/engine/execution-id.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { NodeId, type WorkflowGraph } from '../src/workflow/workflow-graph.js';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../src/capability-authority/runtime-capability-executor.js';
import { HybridExecutionExecutor } from '../src/execution/hybrid-execution-executor.js';
import { buildContractLawyerBundle, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';

/**
 * R5: `'hybrid'`-mode capability execution. Each test proves one of the
 * brief's required behaviors (§10 A-K, minus I — an unsupported
 * capability-level `execution.mode` is already covered end-to-end by
 * `execution-pipeline-r4-router-closure.test.ts`, updated for R5 to use
 * a still-unrecognized value now that `'hybrid'` itself is real; nothing
 * about that proof is hybrid-specific, so it isn't duplicated here).
 *
 * A/B (deterministic-only, model-only regressions) are the *existing*
 * `execution-pipeline-r1-r3-closure.test.ts` and
 * `execution-pipeline-r4-router-closure.test.ts` suites, unmodified
 * apart from the one router-level literal change noted above — they are
 * not re-run here under a new name; their continued, unmodified passing
 * is itself the regression proof (see the delivery report's test table).
 */

function amountSchema(): CapabilityInputSchema {
  return { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] };
}

function hybridCapability(hybridSteps: readonly HybridExecutionStep[], overrides: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
  return {
    id: 'hybrid_review',
    name: 'Hybrid Review',
    description: 'A deterministic check plus a model synthesis step, or vice versa.',
    providerCompatibility: ['claude'],
    requiredComponents: [],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: 0.9, basis: 'expert_review' },
    execution: { mode: 'hybrid', hybridSteps },
    ...overrides,
  };
}

function hybridRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_hybrid_1'),
    capabilityId: 'hybrid_review',
    input: 'review this',
    structuredInput: { amount: 150 },
    environment: {
      environmentId: EnvironmentId('env_1'),
      hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
      provider: 'anthropic',
      tokenBudget: 8000,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A `RuntimeCapabilityExecutor` with one registered deterministic capability, `capability:hybrid-det`, whose handler asserts `input.amount` and always allows (`RuleBasedPolicy([])` + `allow-all` for `runtime.execute`). `onHandlerCalled` lets a test observe whether the handler actually ran. */
function buildDeterministicAuthority(options: { readonly handler?: (input: unknown) => Promise<ReturnType<typeof ok> | ReturnType<typeof err>>; readonly denyPermission?: boolean } = {}) {
  const registry = new RuntimeCapabilityRegistry();
  const registered = registry.register({
    declaration: {
      capabilityId: 'capability:hybrid-det',
      inputContract: { description: '{ amount: number }' },
      outputContract: { description: '{ matched: boolean }' },
      handler: options.handler ?? (async (input) => ok({ matched: (input as { amount: number }).amount > 100 })),
    },
    requiredPermissions: [{ permission: Permissions.runtime.execute }],
  });
  assert.equal(registered.ok, true);

  const manager = new PermissionManager({
    policy: new RuleBasedPolicy(options.denyPermission ? [] : [{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]),
  });
  return new RuntimeCapabilityExecutor({ registry, permissionManager: manager });
}

// --- C: deterministic_rule -> model ----------------------------------------

test('R5-C: deterministic_rule -> model: the deterministic step runs first, its output is threaded into the model step, and the final result is the model response', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'Approved based on the deterministic check.', usage: { inputTokens: 12, outputTokens: 6 }, modelUsed: 'test-model', finishReason: 'stop' });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: buildDeterministicAuthority() });
    const result = await engine.execute(hybridRequest());

    assert.equal(result.session.status, 'completed');
    assert.equal(result.error, undefined);
    assert.equal(result.response?.content, 'Approved based on the deterministic check.');
    assert.equal(provider.requests.length, 1, 'the model step must run exactly once');
    // The second step's own input must actually be the first step's output, not the original request text.
    const lastMessage = provider.requests[0]?.messages.at(-1);
    assert.equal(lastMessage?.content, JSON.stringify({ matched: true }));
    assert.deepEqual(result.receipt?.hybridSteps, [
      { stepId: 'det', strategy: 'deterministic_rule' },
      { stepId: 'model', strategy: 'model' },
    ]);
  });
});

// --- D: model -> deterministic_rule ----------------------------------------

test('R5-D: model -> deterministic_rule: the model step runs first, its output is threaded into the deterministic step, and the deterministic step executes using the supplied input', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'model', strategy: 'model', input: { kind: 'request' } },
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'step', stepId: 'model' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    // The model "extracts" a structured amount as JSON text -- exactly the shape the deterministic step's inputSchema expects.
    provider.setResponse({ text: JSON.stringify({ amount: 250 }), usage: { inputTokens: 8, outputTokens: 4 }, modelUsed: 'test-model', finishReason: 'stop' });

    let receivedInput: unknown;
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildDeterministicAuthority({
        handler: async (input) => {
          receivedInput = input;
          return ok({ matched: (input as { amount: number }).amount > 100 });
        },
      }),
    });
    const result = await engine.execute(hybridRequest());

    assert.equal(result.session.status, 'completed');
    assert.deepEqual(receivedInput, { amount: 250 }, 'the deterministic step must receive the model step\'s output, not the original structuredInput');
    assert.equal(result.response?.content, JSON.stringify({ matched: true }));
    assert.equal(provider.requests.length, 1);
  });
});

// --- E: first-step failure --------------------------------------------------

test('R5-E: first-step failure: the deterministic step fails, the model step is never executed, and the overall invocation fails', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildDeterministicAuthority({ handler: async () => err(new RuntimeError(ErrorCode.RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE, 'deliberate step-1 failure')) }),
    });
    const result = await engine.execute(hybridRequest());

    assert.equal(result.session.status, 'failed');
    assert.equal(result.error?.code, 'XO_RUNTIME_CAPABILITY_HANDLER_UNAVAILABLE');
    assert.equal(provider.requests.length, 0, 'the model step must never run after step 1 fails');
    assert.equal(result.receipt, undefined, 'no successful final receipt after a failed hybrid step');
  });
});

// --- F: later-step failure ---------------------------------------------------

test('R5-F: later-step failure: the deterministic step succeeds, the model step fails, and the overall invocation fails', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.failNextWith = new Error('provider unavailable');

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: buildDeterministicAuthority() });
    const result = await engine.execute(hybridRequest());

    assert.equal(result.session.status, 'failed');
    assert.equal(result.error?.code, 'XO_RUNTIME_EXECUTION_FAILED');
    assert.equal(provider.requests.length, 1, 'the model step must have been attempted');
    assert.equal(result.receipt, undefined, 'no successful final receipt after a failed hybrid step');
  });
});

// --- G: authorization failure ------------------------------------------------

test('R5-G: authorization failure: the deterministic step\'s permission check is denied, the model step is never executed, and the overall invocation is denied', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    let handlerCalled = false;
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildDeterministicAuthority({
        handler: async (input) => {
          handlerCalled = true;
          return ok({ matched: (input as { amount: number }).amount > 100 });
        },
        denyPermission: true,
      }),
    });
    const result = await engine.execute(hybridRequest());

    assert.equal(result.session.status, 'failed');
    assert.equal(result.error?.code, 'XO_RUNTIME_PERMISSION_DENIED');
    assert.equal(handlerCalled, false, 'a denied permission must prevent the deterministic handler itself from running');
    assert.equal(provider.requests.length, 0, 'the model step must never run after the deterministic step is denied');
  });
});

// --- H: R2 validation ---------------------------------------------------------

test('R5-H: R2 validation: the deterministic step receives invalid structured input, validation fails before any execution, and the model step never runs', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    let handlerCalled = false;
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildDeterministicAuthority({
        handler: async (input) => {
          handlerCalled = true;
          return ok({ matched: (input as { amount: number }).amount > 100 });
        },
      }),
    });
    // missing the required `amount` property entirely
    const result = await engine.execute(hybridRequest({ structuredInput: {} }));

    assert.equal(result.session.status, 'failed');
    assert.equal(result.error?.code, 'XO_RUNTIME_CAPABILITY_INPUT_INVALID');
    assert.equal(handlerCalled, false, 'validation must fail before the deterministic handler is ever invoked');
    assert.equal(provider.requests.length, 0, 'the model step must never run after step 1 fails R2 validation');
  });
});

// --- L: cancellation mid-hybrid-model-step -----------------------------------

test('R5-L: cancelling an in-flight hybrid invocation during its model step stops the invocation, matching the existing whole-request cancellation contract', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.delayMs = 200; // gives the test time to cancel while the model step is still in flight

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: buildDeterministicAuthority() });
    const request = hybridRequest();
    const resultPromise = engine.execute(request);
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the deterministic step finish and the model call start
    const cancelled = engine.cancel(deriveExecutionId(request.requestId), 'user cancelled');
    assert.equal(cancelled, true);

    const result = await resultPromise;
    assert.equal(result.session.status, 'cancelled');
    assert.equal(result.error?.code, 'XO_RUNTIME_EXECUTION_CANCELLED');
    assert.equal(result.receipt, undefined, 'no successful final receipt after a cancelled hybrid step');
  });
});

// --- J: workflow preservation -------------------------------------------------

test('R5-J: an existing WorkflowExecutor "capability" node can invoke a hybrid capability successfully, with no workflow-layer modifications required', async () => {
  await withTempInstaller(async (installer) => {
    // model -> deterministic_rule, not deterministic_rule -> model: the
    // synthetic per-node `ExecutionRequest` `makeCapabilityNodeHandler`
    // builds (workflow-node-handlers.ts) only ever carries `config.input`
    // (a plain string) -- it does not forward a `structuredInput` field at
    // all, a pre-existing characteristic of the capability-node handler
    // that predates and is unrelated to R5 (a non-hybrid `'deterministic_rule'`
    // capability invoked from a workflow node has the exact same
    // characteristic: `request.structuredInput` is always `{}` there).
    // This test deliberately uses a step order whose `{ kind: 'request' }`
    // reference only needs `request.input` (the free-text field the
    // handler does forward), so it proves genuine hybrid-through-workflow
    // execution without needing any workflow-layer change.
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'model', strategy: 'model', input: { kind: 'request' } },
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'step', stepId: 'model' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: JSON.stringify({ amount: 150 }), usage: { inputTokens: 5, outputTokens: 5 }, modelUsed: 'test-model', finishReason: 'stop' });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: buildDeterministicAuthority() });

    const graph: WorkflowGraph = {
      graphId: 'hybrid_capability_wf',
      version: '1.0.0',
      startNodeId: NodeId('hybrid_step'),
      nodes: [{ id: NodeId('hybrid_step'), type: 'capability', config: { capabilityId: 'hybrid_review', input: 'review this' } }],
      edges: [],
    };

    const request: ExecutionRequest = {
      requestId: RequestId('wf_req_hybrid_1'),
      environment: { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] }, provider: 'anthropic', tokenBudget: 8000, createdAt: '2026-01-01T00:00:00.000Z' },
      requestedAt: '2026-01-01T00:00:00.000Z',
      workflowGraph: graph,
    };

    const result = await engine.execute(request);

    assert.equal(result.workflowResult?.instance.status, 'completed');
    assert.equal(result.workflowResult?.instance.state.outputs['hybrid_step'], JSON.stringify({ matched: true }));
    assert.equal(provider.requests.length, 1);
  });
});

// --- K: no recursive hybrid ---------------------------------------------------

test('R5-K: a hybrid step declaring strategy "hybrid" itself fails closed rather than silently running as a model step', async () => {
  let providerCalls = 0;
  const spyingExecutor = new HybridExecutionExecutor({
    // `HybridStepStrategy` excludes 'hybrid' at the type level (no recursive
    // nesting) -- reached here only via the same kind of deliberate cast
    // `execution-strategy-router.test.ts` uses to simulate an unrecognized
    // capability-level mode; this proves the runtime behavior for a step
    // that bypasses that compile-time guarantee.
    capabilityExecutor: { execute: async (request) => (providerCalls++, ok(await new ScriptedModelProvider().complete(request))) } as never,
    capabilityAuthorityExecutor: undefined,
  });

  const recursiveStep = { stepId: 'nested', strategy: 'hybrid', input: { kind: 'request' } } as unknown as HybridExecutionStep;
  const noRaceCancellation = async <T>(promise: Promise<T>): Promise<{ readonly cancelled: false; readonly value: T } | { readonly cancelled: true }> => ({ cancelled: false, value: await promise });
  const result = await spyingExecutor.execute(
    [recursiveStep],
    { requestInput: 'x', structuredInput: {}, capabilityId: 'hybrid_review' },
    (input) => ({ model: 'test-model', messages: [{ role: 'user', content: input }], maxOutputTokens: 100 }),
    noRaceCancellation,
  );

  assert.equal(result.cancelled, false);
  if (!result.cancelled) {
    assert.equal(result.result.ok, false);
    if (!result.result.ok) assert.equal(result.result.error.code, 'XO_RUNTIME_UNSUPPORTED_EXECUTION_MODE');
  }
  assert.equal(providerCalls, 0, 'a step declaring "hybrid" must never be silently executed as a model step');
});
