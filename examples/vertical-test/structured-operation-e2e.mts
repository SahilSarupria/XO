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
  console.log('XO STRUCTURED OPERATION DATA-FLOW PROOF');
  console.log(line());
  console.log('\nSource:\n  structured-operation-data-flow.json  (SEMANTIC CONTRACT / STRUCTURED OPERATION PROOF — not a real customer document)\n');

  // 1. Real compile of a real structured JSON source.
  const text = await readFile(new URL('./structured-operation-data-flow.json', import.meta.url), 'utf8');
  const compileResult = await compileSources([{ kind: 'structured', format: 'json', text, sourcePath: 'structured-operation-data-flow.json' }], {});
  if (!compileResult.ok) {
    console.error('Compilation failed:', compileResult.error);
    process.exit(1);
  }
  const { graph } = compileResult.value;
  const capNodes = graph.allNodes().filter((n) => n.kind === 'capability');
  console.log(`Compiled capabilities: ${capNodes.length} — ${capNodes.map((n) => n.properties.name).join(', ')}`);
  for (const n of capNodes) {
    console.log(`  ${n.properties.name}: inputs=${JSON.stringify(n.properties.inputs)} outputs=${JSON.stringify(n.properties.outputs)}`);
  }

  // 2. Real workflow discovery.
  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  if (!composed.ok) {
    console.error('Workflow composition failed:', composed.error);
    process.exit(1);
  }
  const workflow = composed.value[0];
  if (!workflow) {
    console.error('No candidate workflow discovered.');
    process.exit(1);
  }
  console.log(`\nWorkflow: ${workflow.name}`);

  // 3. Pre-execution data-flow audit — unmodified, existing tooling.
  const dataFlow = auditWorkflowDataFlow(workflow, graph);
  console.log(`\nData-flow bindings found: ${dataFlow.bindings.length}`);
  for (const b of dataFlow.bindings) {
    console.log(`  ${b.producerCapabilityId}.${b.outputParameterName} -> ${b.consumerCapabilityId}.${b.inputParameterName}  [${b.status} / ${b.evidenceKind}]`);
  }

  // 4. THE DEMO-SUPPLIED IMPLEMENTATION for calculate_brokerage — kept
  // entirely outside the generic bridge/executor/workflow engine (see
  // candidate-workflow-bridge.ts's `bindingOverrides` doc comment). No
  // capability id is special-cased anywhere in @xo/runtime's shared
  // machinery; this object is a parameter this demo constructs and
  // passes in, nothing more.
  const calculateBrokerageCapability = capNodes.find((n) => n.properties.name === 'calculate_brokerage');
  const recordBrokerageCapability = capNodes.find((n) => n.properties.name === 'record_brokerage');
  if (!calculateBrokerageCapability || !recordBrokerageCapability) {
    console.error('Expected capabilities not found in compiled graph.');
    process.exit(1);
  }
  const calculateBrokerageBinding: CapabilityBinding = {
    id: 'demo_binding_calculate_brokerage',
    contractId: calculateBrokerageCapability.id as unknown as string,
    implementationClass: 'deterministic_rule',
    resolverName: 'demo-supplied-arithmetic',
    description: 'Demo-supplied implementation: brokerage = premium * rate. Not derived from the source, not a formula engine — a single hand-written function for this one proof, supplied by the caller running the workflow.',
    evaluate: (input) => {
      const premium = input.premium;
      const rate = input.rate;
      if (typeof premium !== 'number' || typeof rate !== 'number') {
        return { ok: false, error: 'calculate_brokerage requires numeric premium and rate inputs' };
      }
      return { ok: true, value: { matched: true, brokerage: premium * rate } };
    },
    derivation: { kind: 'demo-supplied', formula: 'premium * rate' },
  };
  // record_brokerage is a pure "sink" — no comparison rule, no action-
  // knowledge grounding of its own (it's declared purely by explicit
  // structured I/O, not prose the ActionEscalation resolver can read).
  // A tiny demo-supplied deterministic binding stands in for "actually
  // persisting the value" for this proof, same rationale as the
  // producer's binding above.
  const recordBrokerageBinding: CapabilityBinding = {
    id: 'demo_binding_record_brokerage',
    contractId: recordBrokerageCapability.id as unknown as string,
    implementationClass: 'deterministic_rule',
    resolverName: 'demo-supplied-sink',
    description: 'Demo-supplied implementation: records the received brokerage value. A single hand-written function for this one proof.',
    evaluate: (input) => ({ ok: true, value: { matched: true, status: 'recorded', brokerage: input.brokerage } }),
    derivation: { kind: 'demo-supplied' },
  };

  // 5. THE BRIDGE — real, unmodified except for the new optional
  // bindingOverrides parameter.
  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(
    workflow,
    graph,
    registry,
    new Map([
      [calculateBrokerageCapability.id as unknown as string, calculateBrokerageBinding],
      [recordBrokerageCapability.id as unknown as string, recordBrokerageBinding],
    ]),
  );

  console.log('\nSteps:');
  for (const s of prepared.steps) {
    console.log(`  [${s.status.toUpperCase()}] ${s.capabilityName}  strategy=${s.implementationClass ?? '(none)'}`);
  }
  console.log(`\nProven data-flow bindings wired as runtime injections: ${prepared.wiredInjections.length}`);
  for (const w of prepared.wiredInjections) {
    console.log(`  ${w.producerCapabilityId}.${w.outputParameterName} -> ${w.consumerCapabilityId}.${w.inputParameterName}`);
  }

  // 6. THE EXECUTOR — real, unmodified.
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
  const workflowExecutor = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable: this bridge graph contains no built-in "capability" nodes');
    },
    { customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]) },
  );

  // Seed calculate_brokerage's own inputs (premium, rate) statically —
  // it is the first step, with no upstream producer of its own.
  const producerNode = prepared.graph.nodes.find((n) => n.name === 'calculate_brokerage');
  const seededGraph = { ...prepared.graph, nodes: prepared.graph.nodes.map((n) => (n.id === producerNode!.id ? { ...n, config: { ...n.config, structuredInput: { premium: 100000, rate: 0.1 } } } : n)) };

  const environment = { environmentId: EnvironmentId('env_structured_operation_demo'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: new Date().toISOString() };
  const result = await workflowExecutor.run(seededGraph, environment);

  console.log('\n' + line('-'));
  console.log('Execution Evidence');
  console.log(line('-'));
  const producerOutput = result.instance.state.outputs[producerNode!.id as unknown as string] as { result?: { brokerage?: number } };
  console.log(`\ncalculate_brokerage`);
  console.log(`  input:  premium=100000, rate=0.10`);
  console.log(`  output: brokerage=${producerOutput.result?.brokerage}`);

  const consumerNode = prepared.graph.nodes.find((n) => n.name === 'record_brokerage');
  const consumerOutput = result.instance.state.outputs[consumerNode!.id as unknown as string] as { result?: { status?: string }; appliedInputBindings?: unknown[] };
  console.log(`\nrecord_brokerage`);
  console.log(`  appliedInputBindings: ${JSON.stringify(consumerOutput.appliedInputBindings)}`);
  console.log(`  status: ${consumerOutput.result?.status}`);

  console.log('\n' + line('-'));
  console.log(`Engine-level WorkflowInstance.status: ${result.instance.status}`);
  console.log(line('-'));

  console.log(`\nProvenance for "brokerage" output:`);
  console.log(`  source: structured-operation-data-flow.json, record 1 (calculate_brokerage), field "operation:output:brokerage"`);
  console.log(`  contract: ${calculateBrokerageCapability.id}`);
  console.log(`  derivedFrom: declared`);
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  process.exit(1);
});
