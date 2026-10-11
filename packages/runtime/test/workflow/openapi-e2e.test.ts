import { test } from 'node:test';
import { testSubject } from '../authz-helpers.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileSources } from '@xo/compiler';
import { composeWorkflows } from '@xo/workflow-composer';
import type { CapabilityBinding } from '@xo/capability-contract';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { RuntimeCapabilityRegistry } from '../../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../../src/capability-authority/runtime-capability-executor.js';
import { WorkflowExecutor } from '../../src/workflow/workflow-executor.js';
import { EnvironmentId } from '../../src/ids.js';
import { prepareCandidateWorkflowForExecution, makeCapabilityAuthorityNodeHandler } from '../../src/workflow/candidate-workflow-bridge.js';

test("REAL SOURCE FIXTURE (OpenAPI) end-to-end: a value computed by a real compiled OpenAPI operation crosses into another real capability's execution input", async () => {
  const text = await readFile(new URL('../../../../examples/vertical-test/openapi-operation-data-flow.json', import.meta.url), 'utf8');
  const compileResult = await compileSources([{ kind: 'openapi', text, sourcePath: 'openapi-operation-data-flow.json' }], {});
  assert.equal(compileResult.ok, true);
  if (!compileResult.ok) return;
  const { graph } = compileResult.value;

  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  const workflow = composed.value.find(
    (w) => w.steps.some((s) => s.capabilityName === 'calculate_brokerage') && w.steps.some((s) => s.capabilityName === 'record_brokerage'),
  );
  assert.ok(workflow);

  const producerNode = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'calculate_brokerage');
  const consumerNode = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'record_brokerage');
  assert.ok(producerNode && consumerNode);

  const calculateBrokerageBinding: CapabilityBinding = {
    id: 'test_openapi_binding_calculate_brokerage',
    contractId: producerNode!.id as unknown as string,
    implementationClass: 'deterministic_rule',
    resolverName: 'test-supplied-arithmetic',
    description: 'test-supplied: brokerage = premium * rate',
    evaluate: (input) => ({ ok: true, value: { matched: true, brokerage: (input.premium as number) * (input.rate as number) } }),
    derivation: { kind: 'test-supplied' },
  };
  const recordBrokerageBinding: CapabilityBinding = {
    id: 'test_openapi_binding_record_brokerage',
    contractId: consumerNode!.id as unknown as string,
    implementationClass: 'deterministic_rule',
    resolverName: 'test-supplied-sink',
    description: 'test-supplied: records the received brokerage value',
    evaluate: (input) => ({ ok: true, value: { matched: true, status: 'recorded', brokerage: input.brokerage } }),
    derivation: { kind: 'test-supplied' },
  };

  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(
    workflow!,
    graph,
    registry,
    new Map([
      [producerNode!.id as unknown as string, calculateBrokerageBinding],
      [consumerNode!.id as unknown as string, recordBrokerageBinding],
    ]),
  );
  assert.equal(prepared.unboundStepCount, 0);
  assert.equal(prepared.wiredInjections.length, 1);

  const executor = new RuntimeCapabilityExecutor({
    registry,
    permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }),
    subject: testSubject(),
  });
  const capturedConsumerInputs: Record<string, unknown>[] = [];
  const originalExecute = executor.execute.bind(executor);
  executor.execute = (async (request: { capabilityId: string; input: Record<string, unknown> }) => {
    if (request.capabilityId === (consumerNode!.id as unknown as string)) capturedConsumerInputs.push(request.input);
    return originalExecute(request);
  }) as typeof executor.execute;

  const workflowExecutor = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable');
    },
    {
      customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]),
    },
  );

  const producerGraphNode = prepared.graph.nodes.find((n) => n.name === 'calculate_brokerage');
  assert.ok(producerGraphNode);
  const seededGraph = {
    ...prepared.graph,
    nodes: prepared.graph.nodes.map((n) =>
      n.id === producerGraphNode!.id ? { ...n, config: { ...n.config, structuredInput: { premium: 100000, rate: 0.1 } } } : n,
    ),
  };

  const environment = {
    environmentId: EnvironmentId('env_test_openapi'),
    hostProfile: { family: 'test', capabilities: [] },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const result = await workflowExecutor.run(seededGraph, environment);

  assert.equal(result.instance.status, 'completed');
  assert.equal(capturedConsumerInputs.length, 1);
  assert.equal(capturedConsumerInputs[0]?.brokerage, 10000);
});
