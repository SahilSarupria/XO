import { test } from 'node:test';
import { allowAllPermissionGate } from './authz-helpers.js';
import assert from 'node:assert/strict';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { NodeId, type WorkflowGraph } from '../src/workflow/workflow-graph.js';
import { RequestId, EnvironmentId } from '../src/ids.js';
import { buildRuntimeContext } from '../src/runtime-context.js';
import type { ExecutionRequest } from '../src/execution/execution-request.js';
import { buildContractLawyerBundle, buildFraudDetectorBundle, withTempInstaller, mountBundle, ScriptedModelProvider } from './fixtures.js';

test('a "capability" workflow node genuinely executes through Stage 2\'s ExecutionPipeline (real mount + real provider)', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();
    provider.setResponse({
      text: 'Contract reviewed: low risk.',
      usage: { inputTokens: 50, outputTokens: 20 },
      modelUsed: 'test-model',
      finishReason: 'stop',
    });

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
    });

    const graph: WorkflowGraph = {
      graphId: 'contract_review_wf',
      version: '1.0.0',
      startNodeId: NodeId('review'),
      nodes: [{ id: NodeId('review'), type: 'capability', config: { capabilityId: 'contract_analysis', input: 'Please review this NDA' } }],
      edges: [],
    };

    const request: ExecutionRequest = {
      requestId: RequestId('wf_req_1'),
      environment: {
        environmentId: EnvironmentId('env_1'),
        hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
      workflowGraph: graph,
    };

    const result = await engine.execute(request);

    assert.equal(result.session.status, 'completed');
    assert.equal(result.workflowResult?.instance.status, 'completed');
    assert.equal(result.workflowResult?.instance.state.outputs['review'], 'Contract reviewed: low risk.');
    // Real usage came from the real provider through the real Stage 2 pipeline, not a stub.
    assert.equal(result.workflowResult?.receipt?.resourceUsage.promptTokens, 50);
    assert.equal(result.workflowResult?.receipt?.resourceUsage.completionTokens, 20);
    assert.equal(result.workflowResult?.receipt?.nodeReceipts.length, 1);
    assert.equal(provider.requests.length, 1);
  });
});

test('multiple capability nodes in one workflow each get their own real Stage 2 execution and receipt', async () => {
  await withTempInstaller(async (installer) => {
    const lawyer = buildContractLawyerBundle();
    const fraud = buildFraudDetectorBundle();
    await installer.install(lawyer);
    await installer.install(fraud);
    let registry = await mountBundle(installer, lawyer);
    registry = await mountBundle(installer, fraud, registry);

    const provider = new ScriptedModelProvider();
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
    });

    const graph: WorkflowGraph = {
      graphId: 'two_capability_wf',
      version: '1.0.0',
      startNodeId: NodeId('review'),
      nodes: [
        { id: NodeId('review'), type: 'capability', config: { capabilityId: 'contract_analysis', input: 'review' } },
        { id: NodeId('fraud'), type: 'capability', config: { capabilityId: 'fraud_detection', input: 'check' } },
      ],
      edges: [{ from: NodeId('review'), to: NodeId('fraud') }],
    };

    const request: ExecutionRequest = {
      requestId: RequestId('wf_req_2'),
      environment: {
        environmentId: EnvironmentId('env_1'),
        hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use', 'long_context'] },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
      workflowGraph: graph,
    };

    const result = await engine.execute(request);
    assert.equal(result.workflowResult?.instance.status, 'completed');
    assert.equal(result.workflowResult?.receipt?.nodeReceipts.length, 2);
    assert.equal(provider.requests.length, 2);
  });
});

test('a request without workflowGraph is completely unaffected by Stage 3 (ordinary Stage 2 behavior)', async () => {
  await withTempInstaller(async (installer) => {
    const bundle = buildContractLawyerBundle();
    await installer.install(bundle);
    const registry = await mountBundle(installer, bundle);
    const provider = new ScriptedModelProvider();

    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
    });
    const request: ExecutionRequest = {
      requestId: RequestId('plain_req'),
      capabilityId: 'contract_analysis',
      input: 'Review this',
      environment: {
        environmentId: EnvironmentId('env_1'),
        hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
    };

    const result = await engine.execute(request);
    assert.equal(result.session.status, 'completed');
    assert.equal(result.workflowResult, undefined);
    assert.ok(result.response);
    assert.ok(result.receipt);
  });
});

test('a workflow whose capability node references an unplanned/unmounted capability fails cleanly through the real pipeline', async () => {
  await withTempInstaller(async (installer) => {
    const registry = await (async () => {
      const { PackageRegistry } = await import('../src/registry/mounted-package.js');
      return PackageRegistry.empty();
    })();
    const provider = new ScriptedModelProvider();
    const engine = new ExecutionEngine(() => buildRuntimeContext(registry), installer, provider, {
      permissionGate: allowAllPermissionGate,
    });

    const graph: WorkflowGraph = {
      graphId: 'missing_capability_wf',
      version: '1.0.0',
      startNodeId: NodeId('review'),
      nodes: [{ id: NodeId('review'), type: 'capability', config: { capabilityId: 'contract_analysis', input: 'x' } }],
      edges: [],
    };
    const request: ExecutionRequest = {
      requestId: RequestId('wf_req_missing'),
      environment: {
        environmentId: EnvironmentId('env_1'),
        hostProfile: { family: 'claude', capabilities: ['chat', 'tool_use'] },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
      workflowGraph: graph,
    };

    const result = await engine.execute(request);
    assert.equal(result.workflowResult?.instance.status, 'failed');
    assert.ok(result.error);
  });
});
