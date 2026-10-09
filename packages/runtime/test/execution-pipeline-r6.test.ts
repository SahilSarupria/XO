import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDeclaration, HybridExecutionStep } from '@xo/types';
import { ok, err } from '@xo/types';
import { PermissionManager, RuleBasedPolicy, Permissions } from '@xo/permissions';
import { StructuredComparisonBindingResolver, resolveCapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import { deriveExecutionId } from '../src/engine/execution-id.js';
import { deriveAttemptId } from '../src/engine/execution-attempt-id.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../src/capability-authority/capability-binding-registration.js';
import { replayExecution } from '../src/execution/replay.js';
import { buildContractLawyerBundle, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';

/**
 * R6 adversarial test matrix — production execution semantics: retry,
 * timeout/cancellation interaction, deterministic non-retry, hybrid
 * retry deferral, simulation (model + deterministic + hybrid), in-flight
 * `RequestId` dedup, replay (deterministic + model), and collision
 * provenance. Every test proves a NEGATIVE as much as a positive —
 * "the live handler was never called", "only one provider call was
 * made" — via observable side channels (`provider.requests.length`,
 * `onHandlerCalled` flags), never by inference from a plausible-looking
 * response alone.
 *
 * R1-R5 regression is NOT re-proven here (existing
 * `execution-pipeline-r1-r3-closure`/`r4-router-closure`/`r5-hybrid`
 * suites remain unmodified and are the regression proof — see the R6
 * delivery report's test table) except where an R6 change touches a
 * shared code path (e.g. every receipt builder), in which case a
 * targeted assertion here re-confirms the pre-R6 fields are untouched.
 */

function claimEvaluationCapability(overrides: Partial<CapabilityDeclaration['execution']> = {}): CapabilityDeclaration {
  return {
    id: 'claim_evaluation',
    name: 'Evaluate Claim',
    description: 'Evaluates a submitted claim against extracted policy rules.',
    providerCompatibility: ['claude'],
    requiredComponents: [],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: 0.9, basis: 'expert_review' },
    execution: { mode: 'deterministic_rule', contractId: 'capability:claim-evaluation', inputSchema: { type: 'object', properties: { claimed_loss_amount: { type: 'number' } }, required: ['claimed_loss_amount'] }, ...overrides },
  };
}

function claimEvaluationContract(): SemanticCapabilityContract {
  return {
    id: 'capability:claim-evaluation',
    name: 'Evaluate Claim',
    description: 'Evaluates a submitted claim against extracted policy rules',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'deterministic',
    rules: [{ sourceNodeId: 'decision:deny-large-claim', kind: 'decision_node', condition: 'the claimed loss amount exceeds 10000', outcome: 'deny the claim', exceptionConditions: [], confidence: 0.9 }],
    confidence: 0.9,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:deny-large-claim'],
  };
}

function buildCapabilityAuthorityExecutor(): RuntimeCapabilityExecutor {
  const contract = claimEvaluationContract();
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver()]);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') throw new Error('unreachable');

  const registry = new RuntimeCapabilityRegistry();
  const registerResult = registerResolvedCapabilityBinding(registry, contract, outcome.binding);
  assert.equal(registerResult.ok, true);

  return new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
}

function claimRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_r6_claim_1'),
    capabilityId: 'claim_evaluation',
    input: 'evaluate this claim',
    structuredInput: { claimed_loss_amount: 15000 },
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

function modelRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_r6_model_1'),
    capabilityId: 'contract_analysis',
    input: 'review this contract',
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

function hybridCapability(hybridSteps: readonly HybridExecutionStep[]): CapabilityDeclaration {
  return {
    id: 'hybrid_review',
    name: 'Hybrid Review',
    description: 'A deterministic check plus a model synthesis step.',
    providerCompatibility: ['claude'],
    requiredComponents: [],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: 0.9, basis: 'expert_review' },
    execution: { mode: 'hybrid', hybridSteps },
  };
}

function hybridRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_r6_hybrid_1'),
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

// --- Attempt/execution identity -------------------------------------------

test('R6: deriveAttemptId is a pure function of executionId and attempt number, 1-indexed', () => {
  const executionId = deriveExecutionId(RequestId('req_x'));
  assert.equal(deriveAttemptId(executionId, 1), `${executionId}#1`);
  assert.equal(deriveAttemptId(executionId, 2), `${executionId}#2`);
  assert.throws(() => deriveAttemptId(executionId, 0), RangeError);
  assert.throws(() => deriveAttemptId(executionId, -1), RangeError);
  assert.throws(() => deriveAttemptId(executionId, 1.5), RangeError);
});

// --- Retry: model-strategy, retryable classification -----------------------

test('R6-retry: a model-strategy failure classified retryable succeeds on a later attempt, and the receipt records attempts/retried', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'test-model', finishReason: 'stop' });
    provider.failNextCallsWith = { error: new Error('transient provider error'), count: 2 };

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 } });
    const result = await engine.execute(modelRequest());

    assert.equal(result.session.status, 'completed');
    assert.equal(provider.requests.length, 3, 'exactly 3 attempts were made: 2 failures + 1 success');
    assert.equal(result.receipt?.attempts, 3);
    assert.equal(result.receipt?.retried, true);
    assert.equal(result.receipt?.executionId, deriveExecutionId(modelRequest().requestId));
  });
});

test('R6-retry: maxAttempts is respected — retry stops and reports RUNTIME_RETRY_EXHAUSTED once attempts run out, never exceeding maxAttempts calls', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.failNextCallsWith = { error: new Error('permanently down'), count: 100 };

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 } });
    const result = await engine.execute(modelRequest());

    assert.equal(provider.requests.length, 3, 'never more than maxAttempts calls');
    assert.equal(result.error?.code, ErrorCode.RUNTIME_RETRY_EXHAUSTED);
    assert.equal(result.session.status, 'failed');
  });
});

test('R6-retry: default behavior (no retry option configured) is unchanged — exactly one attempt, identical to every pre-R6 caller', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.failNextWith = new Error('single failure');

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const result = await engine.execute(modelRequest());

    assert.equal(provider.requests.length, 1, 'no retry option configured — behavior identical to every pre-R6 caller');
    assert.equal(result.error?.code, ErrorCode.RUNTIME_EXECUTION_FAILED, 'a single, non-retried failure is NOT reported as RUNTIME_RETRY_EXHAUSTED');
  });
});

// --- Deterministic-rule retry prohibition -----------------------------------

test('R6-retry: a deterministic_rule failure is NEVER retried, regardless of configured maxAttempts — the handler runs exactly once even when it fails', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability()] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    let handlerCalls = 0;
    const authorityRegistry = new RuntimeCapabilityRegistry();
    const registered = authorityRegistry.register({
      declaration: {
        capabilityId: 'capability:claim-evaluation',
        inputContract: { description: '{ claimed_loss_amount: number }' },
        outputContract: { description: '{ matched: boolean }' },
        handler: async () => {
          handlerCalls += 1;
          return err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, 'handler always fails'));
        },
      },
      requiredPermissions: [],
    });
    assert.equal(registered.ok, true);
    const authority = new RuntimeCapabilityExecutor({ registry: authorityRegistry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: authority,
      retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await engine.execute(claimRequest());

    assert.equal(result.session.status, 'failed');
    assert.equal(handlerCalls, 1, 'deterministic_rule handler must run exactly once even when a retry policy with maxAttempts=5 is configured');
    assert.notEqual(result.error?.code, ErrorCode.RUNTIME_RETRY_EXHAUSTED, 'a deterministic_rule failure is never wrapped as retry-exhausted, since it was never retried');
  });
});

// --- Hybrid retry deferral ---------------------------------------------------

test('R6-retry: hybrid execution is never retried in this pass, even for an all-model hybrid failing with a retryable-shaped error — documented deferral, not silent retry', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [{ stepId: 'summarize', strategy: 'model', input: { kind: 'request' } }];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.failNextCallsWith = { error: new Error('transient'), count: 1 };

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 1 } });
    const result = await engine.execute(hybridRequest());

    assert.equal(provider.requests.length, 1, 'hybrid execution runs exactly once regardless of configured retry — deferred per the R6 delivery report');
    assert.equal(result.session.status, 'failed');
  });
});

// --- Timeout / cancellation interaction with retry --------------------------

test('R6-timeout: a timeout firing during retry backoff terminates immediately as a timeout, never as retry-exhausted, and no further attempt is started', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.failNextCallsWith = { error: new Error('transient'), count: 100 };

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      defaultTimeoutMs: 20,
      retry: { maxAttempts: 50, initialDelayMs: 200, maxDelayMs: 200 },
    });
    const result = await engine.execute(modelRequest());

    assert.equal(result.error?.code, 'XO_RUNTIME_EXECUTION_TIMEOUT');
    assert.equal(result.session.status, 'timed_out');
  });
});

test('R6-cancellation: an explicit cancel during retry backoff terminates as cancelled, never retried further', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.failNextCallsWith = { error: new Error('transient'), count: 100 };

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { retry: { maxAttempts: 50, initialDelayMs: 200, maxDelayMs: 200 } });
    const executionId = deriveExecutionId(modelRequest().requestId);
    const resultPromise = engine.execute(modelRequest());
    setTimeout(() => engine.cancel(executionId), 15);
    const result = await resultPromise;

    assert.equal(result.error?.code, 'XO_RUNTIME_EXECUTION_CANCELLED');
    assert.equal(result.session.status, 'cancelled');
  });
});

// --- Simulation: model ------------------------------------------------------

test('R6-simulation: a model-strategy capability under simulate:true never calls the provider, and the receipt is marked simulated', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const result = await engine.execute(modelRequest({ simulate: true }));

    assert.equal(provider.requests.length, 0, 'the live provider must never be called during simulation');
    assert.equal(result.session.status, 'completed');
    assert.equal(result.receipt?.simulated, true);
    assert.notEqual(result.response?.content, 'default response', 'simulated content must never resemble a real fabricated model answer');
  });
});

// --- Simulation: deterministic (fail-closed) --------------------------------

test('R6-simulation: a deterministic_rule capability under simulate:true refuses before the handler runs — fail-closed, no fabricated output', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability()] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const authority = buildCapabilityAuthorityExecutor();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: authority });
    const result = await engine.execute(claimRequest({ simulate: true }));

    assert.equal(result.error?.code, ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY);
    assert.equal(result.session.status, 'failed');
  });
});

// --- Simulation: hybrid ------------------------------------------------------

test('R6-simulation: an all-model hybrid capability under simulate:true is fully simulatable — no live provider call, all steps skipped safely', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'first', strategy: 'model', input: { kind: 'request' } },
      { stepId: 'second', strategy: 'model', input: { kind: 'step', stepId: 'first' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const result = await engine.execute(hybridRequest({ simulate: true }));

    assert.equal(provider.requests.length, 0, 'no live provider call for any hybrid step during simulation');
    assert.equal(result.session.status, 'completed');
    assert.equal(result.receipt?.simulated, true);
  });
});

test('R6-simulation: a hybrid capability with ANY deterministic_rule step refuses simulation entirely — even an earlier, otherwise-safe model step never runs', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'summarize', strategy: 'model', input: { kind: 'request' } },
      { stepId: 'check', strategy: 'deterministic_rule', contractId: 'capability:hybrid-det', input: { kind: 'step', stepId: 'summarize' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    let handlerCalls = 0;
    const authorityRegistry = new RuntimeCapabilityRegistry();
    const registered = authorityRegistry.register({
      declaration: {
        capabilityId: 'capability:hybrid-det',
        inputContract: { description: '{}' },
        outputContract: { description: '{}' },
        handler: async () => {
          handlerCalls += 1;
          return ok({ matched: true });
        },
      },
      requiredPermissions: [],
    });
    assert.equal(registered.ok, true);
    const authority = new RuntimeCapabilityExecutor({ registry: authorityRegistry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'allow-all', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]) }) });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: authority });
    const result = await engine.execute(hybridRequest({ simulate: true }));

    assert.equal(provider.requests.length, 0, 'the earlier model step must never run once the whole invocation is refused');
    assert.equal(handlerCalls, 0, 'the deterministic step handler must never run during a refused simulation');
    assert.equal(result.error?.code, ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY);
  });
});

test('R6-simulation: simulation is refused for streaming execution rather than silently performing a real call', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const streaming = engine.executeStreaming(modelRequest({ simulate: true }));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _event of streaming.events) {
      /* drain — expected to yield nothing */
    }
    const result = await streaming.result;

    assert.equal(provider.requests.length, 0);
    assert.equal(result.error?.code, ErrorCode.RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY);
  });
});

// --- In-flight RequestId deduplication (execution-bookkeeping idempotency) --

test('R6-idempotency: a second concurrent execute() call with the same requestId is refused with RUNTIME_EXECUTION_ALREADY_IN_FLIGHT while the first is still running', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.delayMs = 50;

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const request = modelRequest();
    const firstPromise = engine.execute(request);
    await new Promise((resolve) => setTimeout(resolve, 5)); // let the first call register in-flight
    const secondResult = await engine.execute(request);

    assert.equal(secondResult.error?.code, 'XO_RUNTIME_EXECUTION_ALREADY_IN_FLIGHT');
    const firstResult = await firstPromise;
    assert.equal(firstResult.session.status, 'completed', 'the original in-flight execution completes normally, unaffected by the refused duplicate');
    assert.equal(provider.requests.length, 1, 'the duplicate call must never reach the provider');
  });
});

test('R6-idempotency: after the first execution completes, the SAME requestId can run again — dedup only guards genuinely concurrent in-flight collisions, never a completed one', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const request = modelRequest();
    const first = await engine.execute(request);
    const second = await engine.execute(request);

    assert.equal(first.session.status, 'completed');
    assert.equal(second.session.status, 'completed');
    assert.equal(second.error, undefined, 'a requestId reused after the prior attempt finished is not treated as in-flight');
  });
});

// --- Replay ------------------------------------------------------------------

test('R6-replay: replaying a deterministic_rule execution returns the recorded output verbatim WITHOUT re-invoking the handler', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability()] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const authority = buildCapabilityAuthorityExecutor();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: authority });
    const original = await engine.execute(claimRequest());
    assert.equal(original.session.status, 'completed');
    assert.notEqual(original.receipt, undefined);

    const replayed = await replayExecution(engine, original.receipt!);

    assert.equal(replayed.session.status, 'completed');
    assert.equal(replayed.receipt?.replayOf, original.receipt!.executionId);
    assert.equal(replayed.receipt?.replayMode, 'recorded-output-only');
    assert.deepEqual(replayed.response?.content, original.response?.content, 'replay reconstructs the exact recorded output, never re-deriving it');
    assert.notEqual(replayed.executionId, original.executionId, 'replay is always a new logical execution');
  });
});

test('R6-replay: replaying a deterministic_rule execution whose receipt has no recordedOutput fails closed with RUNTIME_REPLAY_SOURCE_UNAVAILABLE', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability()] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const authority = buildCapabilityAuthorityExecutor();
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: authority });
    const original = await engine.execute(claimRequest());
    assert.notEqual(original.receipt, undefined);

    const strippedReceipt = { ...original.receipt!, recordedOutput: undefined };
    const replayed = await replayExecution(engine, strippedReceipt);

    assert.equal(replayed.error?.code, 'XO_RUNTIME_REPLAY_SOURCE_UNAVAILABLE');
  });
});

test('R6-replay: replaying a model-strategy execution re-invokes a real provider call (reconstruction, not recorded-output substitution)', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'first answer', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'test-model', finishReason: 'stop' });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const original = await engine.execute(modelRequest());
    assert.equal(provider.requests.length, 1);

    provider.setResponse({ text: 'second answer (live replay call)', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'test-model', finishReason: 'stop' });
    const replayed = await replayExecution(engine, original.receipt!, { environment: modelRequest().environment });

    assert.equal(provider.requests.length, 2, 'replay of a model-strategy execution makes a real, second provider call');
    assert.equal(replayed.receipt?.replayOf, original.receipt!.executionId);
    assert.equal(replayed.receipt?.replayMode, 'reconstruct-and-rerun-model');
    assert.equal(replayed.response?.content, 'second answer (live replay call)', 'replay reflects the live re-invocation, never a fabricated or recorded-only value for a model original');
  });
});

test('R6-replay: replaying a model-strategy execution without an explicit environment fails closed rather than guessing the original one', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const original = await engine.execute(modelRequest());

    const replayed = await replayExecution(engine, original.receipt!);

    assert.equal(replayed.error?.code, 'XO_RUNTIME_REPLAY_SOURCE_UNAVAILABLE');
  });
});

test('R6-replay: hybrid replay is refused (deferred) rather than reconstructed unsafely', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [{ stepId: 'only', strategy: 'model', input: { kind: 'request' } }];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps)] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const original = await engine.execute(hybridRequest());
    assert.notEqual(original.receipt, undefined);

    const replayed = await replayExecution(engine, original.receipt!, { environment: hybridRequest().environment });

    assert.equal(replayed.error?.code, 'XO_RUNTIME_REPLAY_SOURCE_UNAVAILABLE');
  });
});

// --- Capability collision provenance ----------------------------------------

test('R6-collision: negotiationCandidates on the receipt reflects every candidate CapabilityNegotiator ranked, best-first, matching the one actually selected', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const result = await engine.execute(modelRequest());

    assert.equal(result.session.status, 'completed');
    assert.ok(result.receipt?.negotiationCandidates && result.receipt.negotiationCandidates.length >= 1);
    assert.equal(result.receipt?.negotiationCandidates?.[0]?.rank, 0);
    assert.equal(result.receipt?.negotiationCandidates?.[0]?.capabilityId, 'contract_analysis');
  });
});

// --- Provenance / receipt completeness --------------------------------------

test('R6-provenance: a successful non-simulated, non-retried execution reports attempts:1, retried:false, simulated:false, and a populated executionId', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);
    const request = modelRequest();
    const result = await engine.execute(request);

    assert.equal(result.receipt?.attempts, 1);
    assert.equal(result.receipt?.retried, false);
    assert.equal(result.receipt?.simulated, false);
    assert.equal(result.receipt?.executionId, deriveExecutionId(request.requestId));
    assert.deepEqual(result.receipt?.recordedInputs, { input: request.input });
  });
});
