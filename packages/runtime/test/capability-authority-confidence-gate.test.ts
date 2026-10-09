import { test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok } from '@xo/types';
import type { CapabilityDeclaration, CapabilityInputSchema, HybridExecutionStep } from '@xo/types';
import { PermissionManager, RuleBasedPolicy, Permissions } from '@xo/permissions';
import { StructuredComparisonBindingResolver, resolveCapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../src/capability-authority/capability-binding-registration.js';
import { buildContractLawyerBundle, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';

/**
 * M1.4 — closes G1 from the pre-implementation audit: a
 * `deterministic_rule` capability reached directly through
 * `RuntimeCapabilityExecutor`, bypassing `ExecutionPipeline.prepare()`'s
 * existing R3 confidence gate entirely, previously executed regardless
 * of `CapabilityDeclaration.confidence.score`. These tests prove (a) the
 * existing pipeline-level R3 gate is unchanged for every execution
 * strategy, (b) the SAME configured `minConfidence` is now also
 * enforced at the actual execution boundary inside
 * `RuntimeCapabilityExecutor.execute`, and (c) confidence denial and
 * permission denial remain independently distinguishable there, exactly
 * as they already are at the pipeline level.
 *
 * Deliberately does not introduce a second, independently configured
 * threshold anywhere: `minConfidence` is set in exactly one place
 * (`ExecutionPipelineOptions.minConfidence`, or — for the direct-call
 * tests below, which have no pipeline at all — passed straight into the
 * one `RuntimeCapabilityExecutionRequest.minConfidence` field the
 * caller controls).
 */

function amountSchema(): CapabilityInputSchema {
  return { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] };
}

function claimEvaluationCapability(overrides: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
  return {
    id: 'claim_evaluation',
    name: 'Evaluate Claim',
    description: 'Evaluates a submitted claim against extracted policy rules.',
    providerCompatibility: ['claude'],
    requiredComponents: [],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: 0.9, basis: 'expert_review' },
    execution: {
      mode: 'deterministic_rule',
      contractId: 'capability:claim-evaluation',
      inputSchema: { type: 'object', properties: { claimed_loss_amount: { type: 'number' } }, required: ['claimed_loss_amount'] },
    },
    ...overrides,
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

/** Builds a `RuntimeCapabilityExecutor` whose handler resolution is real (via `registerResolvedCapabilityBinding`), so `.handlerCalled` genuinely reflects whether the underlying evaluator ran — not a stand-in flag on a hand-written handler. Read `.handlerCalled` as a property access (never destructure it) since it's a live getter, not a snapshot. */
function buildCapabilityAuthorityExecutor(): { readonly executor: RuntimeCapabilityExecutor; readonly handlerCalled: boolean } {
  const contract = claimEvaluationContract();
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver()]);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') throw new Error('unreachable');

  const registry = new RuntimeCapabilityRegistry();
  const registerResult = registerResolvedCapabilityBinding(registry, contract, outcome.binding);
  assert.equal(registerResult.ok, true);

  const state = { handlerCalled: false };
  const original = registry.resolve('capability:claim-evaluation');
  assert.equal(original.ok, true);
  if (!original.ok) throw new Error('unreachable');
  const originalHandler = original.value.handler;
  // Re-register the same declaration with a wrapped handler so tests can
  // assert "the handler was never invoked" directly, without inferring
  // it from the response shape.
  registry.register({
    declaration: { ...original.value, handler: async (input: unknown) => {
      state.handlerCalled = true;
      return originalHandler(input);
    } },
  });

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
  return {
    executor,
    get handlerCalled(): boolean {
      return state.handlerCalled;
    },
  };
}

function claimRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_claim_1'),
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

// --- Deterministic capability, via ExecutionPipeline ------------------------

test('M1.4: a deterministic_rule capability below the configured minConfidence is denied before the handler runs', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability({ confidence: { score: 0.5, basis: 'self_reported' } })] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const authority = buildCapabilityAuthorityExecutor();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: authority.executor, minConfidence: 0.8 });
    const result = await engine.execute(claimRequest());

    assert.equal(result.error?.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
    assert.equal(result.session.status, 'failed');
    assert.equal(authority.handlerCalled, false, 'a below-threshold deterministic_rule capability must never reach its handler');
  });
});

test('M1.4: a deterministic_rule capability at the configured minConfidence executes', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability({ confidence: { score: 0.8, basis: 'self_reported' } })] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const authority = buildCapabilityAuthorityExecutor();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: authority.executor, minConfidence: 0.8 });
    const result = await engine.execute(claimRequest());

    assert.equal(result.session.status, 'completed');
    assert.equal(result.error, undefined);
    assert.equal(authority.handlerCalled, true);
  });
});

test('M1.4: a deterministic_rule capability above the configured minConfidence executes', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability({ confidence: { score: 0.95, basis: 'expert_review' } })] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const authority = buildCapabilityAuthorityExecutor();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { capabilityAuthorityExecutor: authority.executor, minConfidence: 0.8 });
    const result = await engine.execute(claimRequest());

    assert.equal(result.session.status, 'completed');
    assert.equal(result.error, undefined);
    assert.equal(authority.handlerCalled, true);
  });
});

// --- Hybrid capability, top-level pipeline gate ------------------------------

function hybridCapability(hybridSteps: readonly HybridExecutionStep[], overrides: Partial<CapabilityDeclaration> = {}): CapabilityDeclaration {
  return {
    id: 'hybrid_review',
    name: 'Hybrid Review',
    description: 'A deterministic check plus a model synthesis step.',
    providerCompatibility: ['claude'],
    requiredComponents: [],
    estimatedCost: { currency: 'USD', amount: 0 },
    estimatedLatencyMs: 5,
    confidence: { score: 0.5, basis: 'self_reported' },
    execution: { mode: 'hybrid', hybridSteps },
    ...overrides,
  };
}

function hybridRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    requestId: RequestId('req_hybrid_conf_1'),
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

function buildDeterministicAuthority(onHandlerCalled: () => void): RuntimeCapabilityExecutor {
  const registry = new RuntimeCapabilityRegistry();
  const registered = registry.register({
    declaration: {
      capabilityId: 'capability:hybrid-det',
      inputContract: { description: '{ amount: number }' },
      outputContract: { description: '{ matched: boolean }' },
      handler: async (input) => {
        onHandlerCalled();
        return ok({ matched: (input as { amount: number }).amount > 100 });
      },
    },
    requiredPermissions: [{ permission: Permissions.runtime.execute }],
  });
  assert.equal(registered.ok, true);

  const manager = new PermissionManager({ policy: new RuleBasedPolicy([{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]) });
  return new RuntimeCapabilityExecutor({ registry, permissionManager: manager });
}

test('M1.4: a hybrid capability below the configured minConfidence is denied before any step executes', async () => {
  await withTempInstaller(async (installer) => {
    const steps: readonly HybridExecutionStep[] = [
      { stepId: 'det', strategy: 'deterministic_rule', input: { kind: 'request' }, contractId: 'capability:hybrid-det', inputSchema: amountSchema() },
      { stepId: 'model', strategy: 'model', input: { kind: 'step', stepId: 'det' } },
    ];
    const bundle = buildContractLawyerBundle({ capabilities: [hybridCapability(steps, { confidence: { score: 0.4, basis: 'self_reported' } })] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    let detHandlerCalled = false;

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildDeterministicAuthority(() => {
        detHandlerCalled = true;
      }),
      minConfidence: 0.8,
    });
    const result = await engine.execute(hybridRequest());

    assert.equal(result.error?.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
    assert.equal(result.session.status, 'failed');
    assert.equal(detHandlerCalled, false, 'the deterministic step must never run for a below-threshold hybrid capability');
    assert.equal(provider.requests.length, 0, 'the model step must never run for a below-threshold hybrid capability');
  });
});

// --- Direct RuntimeCapabilityExecutor invocation, no ExecutionPipeline ------

function buildDirectAuthority(options: { readonly denyPermission?: boolean; readonly onHandlerCalled?: () => void } = {}) {
  const registry = new RuntimeCapabilityRegistry();
  const registered = registry.register({
    declaration: {
      capabilityId: 'capability:direct',
      inputContract: { description: '{ amount: number }' },
      outputContract: { description: '{ matched: boolean }' },
      handler: async (input) => {
        options.onHandlerCalled?.();
        return ok({ matched: (input as { amount: number }).amount > 100 });
      },
    },
    requiredPermissions: [{ permission: Permissions.runtime.execute }],
  });
  assert.equal(registered.ok, true);

  const manager = new PermissionManager({
    policy: new RuleBasedPolicy(options.denyPermission ? [] : [{ id: 'allow-runtime-execute', effect: 'ALLOW', match: { permission: Permissions.runtime.execute } }]),
  });
  return new RuntimeCapabilityExecutor({ registry, permissionManager: manager });
}

test('M1.4: a direct RuntimeCapabilityExecutor call below the configured minConfidence is denied without any ExecutionPipeline involved', async () => {
  let handlerCalled = false;
  const executor = buildDirectAuthority({ onHandlerCalled: () => { handlerCalled = true; } });

  const result = await executor.execute({ capabilityId: 'capability:direct', input: { amount: 150 }, confidenceScore: 0.5, minConfidence: 0.8 });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
  assert.equal(handlerCalled, false, 'a below-threshold direct invocation must never reach the handler');
});

test('M1.4: a direct RuntimeCapabilityExecutor call at the configured minConfidence executes', async () => {
  let handlerCalled = false;
  const executor = buildDirectAuthority({ onHandlerCalled: () => { handlerCalled = true; } });

  const result = await executor.execute({ capabilityId: 'capability:direct', input: { amount: 150 }, confidenceScore: 0.8, minConfidence: 0.8 });

  assert.equal(result.ok, true);
  assert.equal(handlerCalled, true);
});

test('M1.4: a direct RuntimeCapabilityExecutor call above the configured minConfidence executes', async () => {
  let handlerCalled = false;
  const executor = buildDirectAuthority({ onHandlerCalled: () => { handlerCalled = true; } });

  const result = await executor.execute({ capabilityId: 'capability:direct', input: { amount: 150 }, confidenceScore: 0.95, minConfidence: 0.8 });

  assert.equal(result.ok, true);
  assert.equal(handlerCalled, true);
});

test('M1.4: a direct RuntimeCapabilityExecutor call with no minConfidence supplied executes regardless of confidenceScore (opt-in, unchanged default)', async () => {
  let handlerCalled = false;
  const executor = buildDirectAuthority({ onHandlerCalled: () => { handlerCalled = true; } });

  const result = await executor.execute({ capabilityId: 'capability:direct', input: { amount: 150 }, confidenceScore: 0.1 });

  assert.equal(result.ok, true);
  assert.equal(handlerCalled, true);
});

// --- Confidence denial vs. permission denial remain distinct ---------------

test('M1.4: confidence denial and permission denial remain independently distinguishable at the RuntimeCapabilityExecutor boundary', async () => {
  // Case 1: confidence fails, permission would also fail — confidence
  // must win (checked first) and the handler must never run.
  let handlerCalled = false;
  const denyingExecutor = buildDirectAuthority({ denyPermission: true, onHandlerCalled: () => { handlerCalled = true; } });
  const confidenceDenied = await denyingExecutor.execute({ capabilityId: 'capability:direct', input: { amount: 150 }, confidenceScore: 0.2, minConfidence: 0.8 });
  assert.equal(confidenceDenied.ok, false);
  if (!confidenceDenied.ok) assert.equal(confidenceDenied.error.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
  assert.equal(handlerCalled, false);

  // Case 2: confidence passes, permission fails — must be reported as a
  // permission denial, not a confidence denial.
  const permissionDenied = await denyingExecutor.execute({ capabilityId: 'capability:direct', input: { amount: 150 }, confidenceScore: 0.95, minConfidence: 0.8 });
  assert.equal(permissionDenied.ok, false);
  if (!permissionDenied.ok) assert.equal(permissionDenied.error.code, 'XO_RUNTIME_PERMISSION_DENIED');
  assert.equal(handlerCalled, false, 'handler must not run when permission is denied either');
});
