import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSources } from '@xo/compiler';
import { composeWorkflows } from '@xo/workflow-composer';
import type { CapabilityBinding } from '@xo/capability-contract';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { RuntimeCapabilityRegistry } from '../../src/capability-authority/runtime-capability-registry.js';
import { RuntimeCapabilityExecutor } from '../../src/capability-authority/runtime-capability-executor.js';
import { WorkflowExecutor } from '../../src/workflow/workflow-executor.js';
import { EnvironmentId } from '../../src/ids.js';
import { prepareCandidateWorkflowForExecution, makeCapabilityAuthorityNodeHandler } from '../../src/workflow/candidate-workflow-bridge.js';

const OPERATION_FIXTURE = [
  { type: 'operation', name: 'calculate_brokerage', inputs: { premium: { type: 'number' }, rate: { type: 'number' } }, outputs: { brokerage: { type: 'number' } } },
  { type: 'operation', name: 'record_brokerage', requires: ['calculate_brokerage'], inputs: { brokerage: { type: 'number' } }, outputs: {} },
];

test('REAL SOURCE FIXTURE end-to-end: a value computed by a real compiled structured-JSON operation actually crosses into another real capability\'s execution input', async () => {
  const compileResult = await compileSources([{ kind: 'structured', format: 'json', text: JSON.stringify(OPERATION_FIXTURE), sourcePath: 'structured-operation-data-flow.json' }], {});
  assert.equal(compileResult.ok, true);
  if (!compileResult.ok) return;
  const { graph } = compileResult.value;

  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  assert.equal(composed.ok, true);
  if (!composed.ok) return;
  const workflow = composed.value.find((w) => w.steps.some((s) => s.capabilityName === 'calculate_brokerage') && w.steps.some((s) => s.capabilityName === 'record_brokerage'));
  assert.ok(workflow);

  const producerNode = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'calculate_brokerage');
  const consumerNode = graph.allNodes().find((n) => n.kind === 'capability' && n.properties.name === 'record_brokerage');
  assert.ok(producerNode && consumerNode);

  // Demo-supplied implementations — see candidate-workflow-bridge.ts's
  // `bindingOverrides` doc comment. No capability id is special-cased
  // anywhere in WorkflowExecutor or the generic node handler; these are
  // ordinary parameters to prepareCandidateWorkflowForExecution.
  const calculateBrokerageBinding: CapabilityBinding = {
    id: 'test_binding_calculate_brokerage',
    contractId: producerNode!.id as unknown as string,
    implementationClass: 'deterministic_rule',
    resolverName: 'test-supplied-arithmetic',
    description: 'test-supplied: brokerage = premium * rate',
    evaluate: (input) => ({ ok: true, value: { matched: true, brokerage: (input.premium as number) * (input.rate as number) } }),
    derivation: { kind: 'test-supplied' },
  };
  const recordBrokerageBinding: CapabilityBinding = {
    id: 'test_binding_record_brokerage',
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

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });

  // Capture the exact argument RuntimeCapabilityExecutor.execute()
  // receives for the consumer — proves the value crossed the actual
  // execution boundary, not merely some intermediate data structure.
  const capturedConsumerInputs: Record<string, unknown>[] = [];
  const originalExecute = executor.execute.bind(executor);
  executor.execute = (async (request: { capabilityId: string; input: Record<string, unknown> }) => {
    if (request.capabilityId === (consumerNode!.id as unknown as string)) capturedConsumerInputs.push(request.input);
    return originalExecute(request);
  }) as typeof executor.execute;

  const workflowExecutor = new WorkflowExecutor(async () => { throw new Error('unreachable'); }, {
    customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]),
  });

  const producerGraphNode = prepared.graph.nodes.find((n) => n.name === 'calculate_brokerage');
  assert.ok(producerGraphNode);
  const seededGraph = { ...prepared.graph, nodes: prepared.graph.nodes.map((n) => (n.id === producerGraphNode!.id ? { ...n, config: { ...n.config, structuredInput: { premium: 100000, rate: 0.1 } } } : n)) };

  const environment = { environmentId: EnvironmentId('env_test_structured_operation'), hostProfile: { family: 'test', capabilities: [] }, createdAt: '2026-01-01T00:00:00.000Z' };
  const result = await workflowExecutor.run(seededGraph, environment);

  assert.equal(result.instance.status, 'completed');
  assert.equal(capturedConsumerInputs.length, 1);
  // THE critical assertion: the consumer's real execution call received
  // the exact number the producer's real execution computed.
  assert.equal(capturedConsumerInputs[0]?.brokerage, 10000);

  const consumerGraphNode = prepared.graph.nodes.find((n) => n.name === 'record_brokerage');
  const consumerOutput = result.instance.state.outputs[consumerGraphNode!.id as unknown as string] as { result?: { status?: string; brokerage?: number } };
  assert.equal(consumerOutput.result?.status, 'recorded');
  assert.equal(consumerOutput.result?.brokerage, 10000);
});
