import { readFile } from 'node:fs/promises';
import { compileSources } from '@xo/compiler';
import { composeWorkflows, auditWorkflowDataFlow } from '@xo/workflow-composer';
import type { CapabilityBinding } from '@xo/capability-contract';
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilityExecutor,
  WorkflowExecutor,
  EnvironmentId,
  prepareCandidateWorkflowForExecution,
  makeCapabilityAuthorityNodeHandler,
} from '@xo/runtime';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';

function line(char = '=') {
  return char.repeat(72);
}

async function main() {
  console.log(line());
  console.log('XO OPENAPI OPERATION DATA-FLOW PROOF');
  console.log(line());

  const text = await readFile(new URL('./openapi-operation-data-flow.json', import.meta.url), 'utf8');
  const compileResult = await compileSources([{ kind: 'openapi', text, sourcePath: 'openapi-operation-data-flow.json' }], {});
  if (!compileResult.ok) {
    console.error('Compilation failed:', compileResult.error);
    process.exit(1);
  }
  const { graph } = compileResult.value;
  const capNodes = graph.allNodes().filter((n) => n.kind === 'capability');
  console.log(`\nCompiled capabilities: ${capNodes.length}`);
  for (const n of capNodes) {
    console.log(`  ${n.properties.name}: inputs=${JSON.stringify(n.properties.inputs)} outputs=${JSON.stringify(n.properties.outputs)}`);
  }

  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  if (!composed.ok) {
    console.error('Workflow composition failed:', composed.error);
    process.exit(1);
  }
  const workflow = composed.value.find((w) => w.steps.some((s) => s.capabilityName === 'calculate_brokerage') && w.steps.some((s) => s.capabilityName === 'record_brokerage'));
  if (!workflow) {
    console.error('Expected workflow not found.');
    process.exit(1);
  }
  console.log(`\nWorkflow: ${workflow.name}`);

  const dataFlow = auditWorkflowDataFlow(workflow, graph);
  console.log(`\nData-flow bindings:`);
  for (const b of dataFlow.bindings) {
    console.log(`  ${b.producerCapabilityId}.${b.outputParameterName} -> ${b.consumerCapabilityId}.${b.inputParameterName}  [${b.status} / ${b.evidenceKind}]`);
  }

  const producerNode = capNodes.find((n) => n.properties.name === 'calculate_brokerage')!;
  const consumerNode = capNodes.find((n) => n.properties.name === 'record_brokerage')!;

  const calculateBrokerageBinding: CapabilityBinding = {
    id: 'demo_binding_calculate_brokerage',
    contractId: producerNode.id as unknown as string,
    implementationClass: 'deterministic_rule',
    resolverName: 'demo-supplied-arithmetic',
    description: 'Demo-supplied implementation: brokerage = premium * rate',
    evaluate: (input) => ({ ok: true, value: { matched: true, brokerage: (input.premium as number) * (input.rate as number) } }),
    derivation: { kind: 'demo-supplied', formula: 'premium * rate' },
  };
  const recordBrokerageBinding: CapabilityBinding = {
    id: 'demo_binding_record_brokerage',
    contractId: consumerNode.id as unknown as string,
    implementationClass: 'deterministic_rule',
    resolverName: 'demo-supplied-sink',
    description: 'Demo-supplied implementation: records the received brokerage value',
    evaluate: (input) => ({ ok: true, value: { matched: true, status: 'recorded', brokerage: input.brokerage } }),
    derivation: { kind: 'demo-supplied' },
  };

  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(
    workflow,
    graph,
    registry,
    new Map([
      [producerNode.id as unknown as string, calculateBrokerageBinding],
      [consumerNode.id as unknown as string, recordBrokerageBinding],
    ]),
  );

  console.log(`\nWired injections: ${prepared.wiredInjections.length}`);

  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
  const workflowExecutor = new WorkflowExecutor(async () => { throw new Error('unreachable'); }, {
    customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]),
  });

  const producerGraphNode = prepared.graph.nodes.find((n) => n.name === 'calculate_brokerage')!;
  const seededGraph = { ...prepared.graph, nodes: prepared.graph.nodes.map((n) => (n.id === producerGraphNode.id ? { ...n, config: { ...n.config, structuredInput: { premium: 100000, rate: 0.1 } } } : n)) };

  const environment = { environmentId: EnvironmentId('env_openapi_demo'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: new Date().toISOString() };
  const result = await workflowExecutor.run(seededGraph, environment);

  const producerOutput = result.instance.state.outputs[producerGraphNode.id as unknown as string] as { result?: { brokerage?: number } };
  const consumerGraphNode = prepared.graph.nodes.find((n) => n.name === 'record_brokerage')!;
  const consumerOutput = result.instance.state.outputs[consumerGraphNode.id as unknown as string] as { result?: { status?: string; brokerage?: number } };

  console.log('\n' + line('-'));
  console.log(`calculate_brokerage(premium=100000, rate=0.10) -> brokerage=${producerOutput.result?.brokerage}`);
  console.log(`record_brokerage received brokerage=${consumerOutput.result?.brokerage}, status=${consumerOutput.result?.status}`);
  console.log(`Engine status: ${result.instance.status}`);
  console.log(line('-'));
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  process.exit(1);
});
