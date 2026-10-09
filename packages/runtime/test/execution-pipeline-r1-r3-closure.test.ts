import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CapabilityDeclaration } from '@xo/types';
import { PermissionManager, RuleBasedPolicy, Permissions } from '@xo/permissions';
import { StructuredComparisonBindingResolver, resolveCapabilityBinding, type SemanticCapabilityContract } from '@xo/capability-contract';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../src/capability-authority/capability-binding-registration.js';
import { buildContractLawyerBundle, contractAnalysisCapability, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';

/**
 * Proves the three R1/R2/R3 gaps identified by the freeze audit are
 * closed: (1) `CapabilityDeclaration.execution.mode` actually routes
 * execution rather than being inert data, (2) a `deterministic_rule`
 * capability's declared `inputSchema` is enforced before its binding
 * runs, and (3) a confidence floor can actually deny execution. Every
 * assertion that the AI Capability Layer was *not* called is made via
 * `provider.requests.length`, not by inference — the whole point being
 * audited is whether that path is truly skipped, not merely whether the
 * response happens to look right.
 */

const claimEvaluationCapability: CapabilityDeclaration = {
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
};

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
    requestId: RequestId('req_claim_1'),
    capabilityId: 'claim_evaluation',
    input: 'evaluate this claim', // Stage 2 still requires a non-empty task string even for a deterministic-rule capability
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

// --- R1: execution.mode actually dispatches -------------------------------

test('R1: a deterministic_rule capability executes via the capability authority, never the AI Capability Layer', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildCapabilityAuthorityExecutor(),
    });

    const result = await engine.execute(claimRequest());

    assert.equal(result.session.status, 'completed');
    assert.equal(result.error, undefined);
    assert.deepEqual(JSON.parse(result.response?.content ?? 'null'), { matched: true, ruleSourceNodeId: 'decision:deny-large-claim', outcome: 'deny the claim' });
    assert.deepEqual(result.receipt?.capabilitiesInvoked, ['claim_evaluation']);
    assert.equal(provider.requests.length, 0, 'the AI Capability Layer must never be called for a deterministic_rule capability');
  });
});

test('R1: a deterministic_rule capability is denied, not silently run as model mode, when no capabilityAuthorityExecutor is configured', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);

    const result = await engine.execute(claimRequest());

    assert.equal(result.error?.code, 'XO_RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED');
    assert.equal(result.session.status, 'failed');
    assert.equal(provider.requests.length, 0, 'a misconfigured deterministic_rule capability must never fall back to the AI Capability Layer');
  });
});

test('R1: a model-mode (execution absent) capability is completely unaffected — continues through the AI Capability Layer exactly as before', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle(); // default capabilities (contractAnalysisCapability, clauseLookupCapability) have no `execution` field
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'test-model', finishReason: 'stop' });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildCapabilityAuthorityExecutor(),
    });

    const result = await engine.execute({
      requestId: RequestId('req_model_1'),
      capabilityId: contractAnalysisCapability.id,
      input: 'Please review this NDA.',
      environment: { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] }, provider: 'anthropic', tokenBudget: 8000, createdAt: '2026-01-01T00:00:00.000Z' },
      requestedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(result.session.status, 'completed');
    assert.equal(provider.requests.length, 1, 'a model-mode capability must still call the AI Capability Layer exactly once');
  });
});

// --- R2: input schema is enforced before the binding runs -----------------

test('R2: invalid structuredInput is rejected before the deterministic binding ever runs', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildCapabilityAuthorityExecutor(),
    });

    // missing the required `claimed_loss_amount` property entirely
    const result = await engine.execute(claimRequest({ structuredInput: {} }));

    assert.equal(result.error?.code, 'XO_RUNTIME_CAPABILITY_INPUT_INVALID');
    assert.equal(result.session.status, 'failed');
    assert.equal(provider.requests.length, 0);
  });
});

test('R2: a wrong-typed structuredInput property is rejected before execution', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildCapabilityAuthorityExecutor(),
    });

    const result = await engine.execute(claimRequest({ structuredInput: { claimed_loss_amount: 'a lot' } }));

    assert.equal(result.error?.code, 'XO_RUNTIME_CAPABILITY_INPUT_INVALID');
    assert.equal(result.session.status, 'failed');
  });
});

test('R2: valid structuredInput matching the schema executes successfully', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluationCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      capabilityAuthorityExecutor: buildCapabilityAuthorityExecutor(),
    });

    const result = await engine.execute(claimRequest({ structuredInput: { claimed_loss_amount: 500 } }));

    assert.equal(result.session.status, 'completed');
    assert.deepEqual(JSON.parse(result.response?.content ?? 'null'), { matched: false });
  });
});

// --- R3: confidence gate ---------------------------------------------------

test('R3: a capability below the configured minConfidence is denied before authorization or execution', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle(); // contractAnalysisCapability has confidence.score = 0.8
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { minConfidence: 0.9 });

    const result = await engine.execute({
      requestId: RequestId('req_conf_1'),
      capabilityId: contractAnalysisCapability.id,
      input: 'Please review this NDA.',
      environment: { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] }, provider: 'anthropic', tokenBudget: 8000, createdAt: '2026-01-01T00:00:00.000Z' },
      requestedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(result.error?.code, 'XO_RUNTIME_CONFIDENCE_BELOW_THRESHOLD');
    assert.equal(result.session.status, 'failed');
    assert.equal(provider.requests.length, 0, 'a below-threshold capability must never reach the AI Capability Layer');
  });
});

test('R3: a capability at or above the configured minConfidence executes normally', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle(); // contractAnalysisCapability has confidence.score = 0.8
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'test-model', finishReason: 'stop' });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, { minConfidence: 0.8 });

    const result = await engine.execute({
      requestId: RequestId('req_conf_2'),
      capabilityId: contractAnalysisCapability.id,
      input: 'Please review this NDA.',
      environment: { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] }, provider: 'anthropic', tokenBudget: 8000, createdAt: '2026-01-01T00:00:00.000Z' },
      requestedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(result.session.status, 'completed');
    assert.equal(provider.requests.length, 1);
  });
});

test('R3: with no minConfidence configured, a low-confidence capability still executes (documented default, matches allowAllPermissionGate\'s port pattern)', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({ text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, modelUsed: 'test-model', finishReason: 'stop' });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider);

    const result = await engine.execute({
      requestId: RequestId('req_conf_3'),
      capabilityId: contractAnalysisCapability.id, // confidence.score = 0.8, well below what a strict deployment might require
      input: 'Please review this NDA.',
      environment: { environmentId: EnvironmentId('env_1'), hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] }, provider: 'anthropic', tokenBudget: 8000, createdAt: '2026-01-01T00:00:00.000Z' },
      requestedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(result.session.status, 'completed');
  });
});
