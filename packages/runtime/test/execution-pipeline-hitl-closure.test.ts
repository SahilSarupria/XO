import { test } from 'node:test';
import { allowAllPermissionGate, testSubject } from './authz-helpers.js';
import assert from 'node:assert/strict';
import type { CapabilityDeclaration } from '@xo/types';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import {
  ActionEscalationBindingResolver,
  StructuredComparisonBindingResolver,
  resolveCapabilityBinding,
  type SemanticCapabilityContract,
} from '@xo/capability-contract';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { RuntimeCapabilityRegistry } from '../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../src/capability-authority/runtime-capability-executor.js';
import { registerResolvedCapabilityBinding } from '../src/capability-authority/capability-binding-registration.js';
import { buildContractLawyerBundle, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';

/**
 * Human-in-the-Loop Execution Class Lowering milestone — the pipeline-level
 * counterpart to `capability-authority/human-in-the-loop-binding.test.ts`
 * (which proves the registration/execution boundary in isolation) and to
 * `execution-pipeline-r1-r3-closure.test.ts`'s R1 tests (which prove the
 * same dispatch for `deterministic_rule`). This file proves the full
 * chain end-to-end through `ExecutionEngine`/`ExecutionPipeline`:
 *
 *   declared execution.mode: 'human_in_the_loop'
 *     -> ExecutionStrategyRouter resolves it to a registered strategy
 *     -> dispatched through the SAME runDeterministicRuleExecution path
 *        deterministic_rule uses (never the AI Capability Layer)
 *     -> RuntimeCapabilityExecutor.execute -> the registered binding's
 *        evaluate() -> an escalation record, `status: 'escalation_required'`
 *
 * The response is asserted to literally carry `escalation_required` —
 * per this milestone's E2E semantic requirement, this must never be
 * represented as successful execution of the underlying business
 * operation (reconciling the invoice). ActionEscalationBindingResolver
 * itself is exercised unmodified, exactly as
 * `human-in-the-loop-binding.test.ts` already does.
 */

const reconcileInvoiceCapability: CapabilityDeclaration = {
  id: 'reconcile_invoice',
  name: 'Reconcile the invoice balance',
  description: 'Reconciles the outstanding invoice balance against recorded payments.',
  providerCompatibility: ['claude'],
  requiredComponents: [],
  estimatedCost: { currency: 'USD', amount: 0 },
  estimatedLatencyMs: 0,
  confidence: { score: 0.72, basis: 'self_reported' },
  execution: {
    mode: 'human_in_the_loop',
    contractId: 'capability:reconcile-invoice-balance',
  },
};

function reconcileInvoiceContract(): SemanticCapabilityContract {
  return {
    id: 'capability:reconcile-invoice-balance',
    name: 'Reconcile the invoice balance',
    description: 'Reconcile the outstanding invoice balance against recorded payments',
    inputs: [],
    outputs: [],
    requiredPermissions: [],
    determinism: 'unknown',
    rules: [],
    actionKnowledgeRefs: [{ sourceNodeId: 'concept:reconcile-action-1', subtype: 'action' }],
    confidence: 0.72,
    sourceRefs: [],
    sourceXoirNodeIds: ['capability:reconcile-invoice-balance', 'concept:reconcile-action-1'],
  };
}

function buildCapabilityAuthorityExecutorWithHitlBinding(): RuntimeCapabilityExecutor {
  const contract = reconcileInvoiceContract();
  // Both default resolvers, exactly as `capability-lowering.ts`'s
  // production default now uses — proves the same resolver *list*
  // reaches the same `human_in_the_loop` outcome at this boundary too.
  const outcome = resolveCapabilityBinding(contract, [new StructuredComparisonBindingResolver(), new ActionEscalationBindingResolver()]);
  assert.equal(outcome.status, 'resolved');
  if (outcome.status !== 'resolved') throw new Error('unreachable');
  assert.equal(outcome.binding.implementationClass, 'human_in_the_loop');

  const registry = new RuntimeCapabilityRegistry();
  const registerResult = registerResolvedCapabilityBinding(registry, contract, outcome.binding);
  assert.equal(registerResult.ok, true);

  return new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
}

function reconcileRequest(): ExecutionRequest {
  return {
    requestId: RequestId('req_hitl_1'),
    capabilityId: 'reconcile_invoice',
    input: 'reconcile the invoice balance',
    structuredInput: {},
    environment: {
      environmentId: EnvironmentId('env_1'),
      hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
      provider: 'anthropic',
      tokenBudget: 8000,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('HITL pipeline (1): a human_in_the_loop capability executes via the capability authority, never the AI Capability Layer', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [reconcileInvoiceCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
      capabilityAuthorityExecutor: buildCapabilityAuthorityExecutorWithHitlBinding(),
    });

    const result = await engine.execute(reconcileRequest());

    assert.equal(result.session.status, 'completed');
    assert.equal(result.error, undefined);
    const response = JSON.parse(result.response?.content ?? 'null');
    assert.equal(
      response.status,
      'escalation_required',
      'a human_in_the_loop capability must report escalation_required, never a fabricated successful business-action result',
    );
    assert.equal(response.capabilityId, 'capability:reconcile-invoice-balance');
    assert.deepEqual(result.receipt?.capabilitiesInvoked, ['reconcile_invoice']);
    assert.equal(provider.requests.length, 0, 'the AI Capability Layer must never be called for a human_in_the_loop capability');
  });
});

test('HITL pipeline (2): a human_in_the_loop capability is denied, not silently run as model mode, when no capabilityAuthorityExecutor is configured', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [reconcileInvoiceCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
    });

    const result = await engine.execute(reconcileRequest());

    assert.equal(result.error?.code, 'XO_RUNTIME_CAPABILITY_AUTHORITY_NOT_CONFIGURED');
    assert.equal(result.session.status, 'failed');
    assert.equal(
      provider.requests.length,
      0,
      'a misconfigured human_in_the_loop capability must never fall back to the AI Capability Layer',
    );
  });
});

test('HITL pipeline (3): simulate: true refuses a human_in_the_loop capability rather than calling the live handler or fabricating an output', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle({ capabilities: [reconcileInvoiceCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
      capabilityAuthorityExecutor: buildCapabilityAuthorityExecutorWithHitlBinding(),
    });

    const result = await engine.execute({ ...reconcileRequest(), simulate: true });

    assert.equal(result.error?.code, 'XO_RUNTIME_SIMULATION_UNSUPPORTED_FOR_STRATEGY');
    assert.equal(result.session.status, 'failed');
    assert.equal(provider.requests.length, 0);
  });
});

test('HITL pipeline (4): a deterministic_rule capability in the SAME package is completely unaffected by human_in_the_loop support existing alongside it', async () => {
  await withTempInstaller(async (installer) => {
    const claimEvaluation: CapabilityDeclaration = {
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
    const claimContract: SemanticCapabilityContract = {
      id: 'capability:claim-evaluation',
      name: 'Evaluate Claim',
      description: 'Evaluates a submitted claim against extracted policy rules',
      inputs: [],
      outputs: [],
      requiredPermissions: [],
      determinism: 'deterministic',
      rules: [
        {
          sourceNodeId: 'decision:deny-large-claim',
          kind: 'decision_node',
          condition: 'the claimed loss amount exceeds 10000',
          outcome: 'deny the claim',
          exceptionConditions: [],
          confidence: 0.9,
        },
      ],
      confidence: 0.9,
      sourceRefs: [],
      sourceXoirNodeIds: ['capability:claim-evaluation', 'decision:deny-large-claim'],
    };
    const detOutcome = resolveCapabilityBinding(claimContract, [
      new StructuredComparisonBindingResolver(),
      new ActionEscalationBindingResolver(),
    ]);
    assert.equal(detOutcome.status, 'resolved');
    if (detOutcome.status !== 'resolved') throw new Error('unreachable');
    assert.equal(detOutcome.binding.implementationClass, 'deterministic_rule');

    const hitlContract = reconcileInvoiceContract();
    const hitlOutcome = resolveCapabilityBinding(hitlContract, [
      new StructuredComparisonBindingResolver(),
      new ActionEscalationBindingResolver(),
    ]);
    assert.equal(hitlOutcome.status, 'resolved');
    if (hitlOutcome.status !== 'resolved') throw new Error('unreachable');

    const authorityRegistry = new RuntimeCapabilityRegistry();
    assert.equal(registerResolvedCapabilityBinding(authorityRegistry, claimContract, detOutcome.binding).ok, true);
    assert.equal(registerResolvedCapabilityBinding(authorityRegistry, hitlContract, hitlOutcome.binding).ok, true);
    const capabilityAuthorityExecutor = new RuntimeCapabilityExecutor({
      registry: authorityRegistry,
      permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
      subject: testSubject(),
    });

    const bundle = buildContractLawyerBundle({ capabilities: [claimEvaluation, reconcileInvoiceCapability] });
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
      capabilityAuthorityExecutor,
    });

    const detResult = await engine.execute({
      requestId: RequestId('req_claim_2'),
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
    });
    assert.equal(detResult.session.status, 'completed');
    assert.deepEqual(JSON.parse(detResult.response?.content ?? 'null'), {
      matched: true,
      ruleSourceNodeId: 'decision:deny-large-claim',
      outcome: 'deny the claim',
    });

    const hitlResult = await engine.execute(reconcileRequest());
    assert.equal(hitlResult.session.status, 'completed');
    assert.equal(JSON.parse(hitlResult.response?.content ?? 'null').status, 'escalation_required');

    assert.equal(provider.requests.length, 0);
  });
});
