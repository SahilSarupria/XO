import { readFile } from 'node:fs/promises';
import { compileSources } from '@xo/compiler';
import { composeWorkflows, auditWorkflowExecutability, auditWorkflowDataFlow } from '@xo/workflow-composer';
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilityExecutor,
  WorkflowExecutor,
  NodeId,
  prepareCandidateWorkflowForExecution,
  makeCapabilityAuthorityNodeHandler,
  deriveWorkflowRunStatus,
} from '@xo/runtime';
import { PermissionManager, RuleBasedPolicy } from '@xo/permissions';
import { EnvironmentId } from '@xo/runtime';

function line(char = '=') {
  return char.repeat(72);
}

async function main() {
  console.log(line());
  console.log('XO — Aastha Workflow Automation (real E2E)');
  console.log(line());
  console.log('\nSource:\n  Aastha Insurance Operations and Procedures.pdf\n');

  // 1. Real compile.
  const bytes = new Uint8Array(await readFile(new URL('./Aastha.pdf', import.meta.url)));
  const compileResult = await compileSources([{ kind: 'pdf', bytes, sourcePath: 'Aastha.pdf' }], {});
  if (!compileResult.ok) {
    console.error('Compilation failed:', compileResult.error);
    process.exit(1);
  }
  const { graph } = compileResult.value;

  // 2. Real workflow discovery.
  const composed = composeWorkflows(graph, { now: () => new Date().toISOString() });
  if (!composed.ok) {
    console.error('Workflow composition failed:', composed.error);
    process.exit(1);
  }

  // 3. Select the workflow grounded in the "Brokerage Reconciliation"
  // section — the largest, most source-grounded candidate (see the audit
  // report for why the other three are worse-supported: one has a
  // circular_dependency across its own steps, one is a single step, one
  // has no shared sectionPath at all).
  const workflow = composed.value.find((w) => w.processGrouping?.sectionPath.some((p) => p.includes('Brokerage Reconciliation')));
  if (!workflow) {
    console.error('Expected Brokerage Reconciliation workflow not found among candidates.');
    process.exit(1);
  }

  console.log(`Workflow:\n  ${workflow.name}`);
  console.log(`  (source section: ${workflow.processGrouping.sectionPath.join(' > ')})\n`);

  // 4. Executability + data-flow audit (unmodified, existing tooling) —
  // printed honestly before any execution is attempted.
  const execReport = auditWorkflowExecutability(workflow, graph);
  const dataFlow = auditWorkflowDataFlow(workflow, graph);
  console.log(`Executability status (pre-execution): ${execReport.status}`);
  console.log(`Proven data-flow bindings: ${dataFlow.bindings.length}  |  Unbound inputs: ${dataFlow.unboundInputs.length}`);
  console.log('(No field-level output->input relationship is provable from this document\'s evidence — every step below runs from its own contract, not from a prior step\'s output.)\n');

  // 5. THE BRIDGE: CandidateWorkflow -> registered bindings + WorkflowGraph.
  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(workflow, graph, registry);

  console.log('Steps:');
  for (const s of prepared.steps) {
    console.log(`  [${s.status === 'bound' ? 'BOUND' : 'UNBOUND'}] ${s.capabilityName}`);
    if (s.status === 'bound') {
      console.log(`         strategy: ${s.implementationClass}   binding: ${s.bindingId}`);
    } else {
      console.log(`         reason: ${s.reason}`);
    }
  }
  console.log(`\n${prepared.steps.length - prepared.unboundStepCount}/${prepared.steps.length} steps bound to a registered, executable binding.\n`);

  // 6. THE EXECUTOR: real WorkflowExecutor, running the real registered
  // bindings through the real RuntimeCapabilityExecutor — via the
  // documented customNodeHandlers extension point, not a second engine.
  const executor = new RuntimeCapabilityExecutor({ registry, permissionManager: new PermissionManager({ policy: new RuleBasedPolicy([]) }) });
  const workflowExecutor = new WorkflowExecutor(
    async () => {
      throw new Error('unreachable: this bridge graph contains no built-in "capability" nodes');
    },
    { customNodeHandlers: new Map([['custom:capability-authority', makeCapabilityAuthorityNodeHandler(executor)]]) },
  );

  const environment = { environmentId: EnvironmentId('env_aastha_demo'), hostProfile: { family: 'claude', capabilities: [] }, createdAt: new Date().toISOString() };
  const result = await workflowExecutor.run(prepared.graph, environment);

  console.log(line('-'));
  console.log('Execution Evidence');
  console.log(line('-'));
  for (const entry of result.instance.state.history) {
    if (entry.status === 'completed' && entry.nodeId !== 'start' && entry.nodeId !== 'end') {
      const output = result.instance.state.outputs[entry.nodeId];
      console.log(`\n${entry.nodeId}`);
      console.log(`  status: ${entry.status}   durationMs: ${entry.durationMs}`);
      console.log(`  output: ${JSON.stringify(output)}`);
    } else if (entry.status === 'failed') {
      console.log(`\n${entry.nodeId}`);
      console.log(`  status: FAILED   error: ${entry.error}`);
    }
  }

  const runStatus = deriveWorkflowRunStatus({
    engineStatus: result.instance.status,
    nodeOutputs: result.instance.state.outputs,
    unboundStepCount: prepared.unboundStepCount,
    boundStepCount: prepared.steps.length - prepared.unboundStepCount,
  });

  console.log('\n' + line('-'));
  console.log(`Engine-level WorkflowInstance.status: ${result.instance.status}`);
  console.log(`Product-surface workflow status:      ${runStatus}`);
  console.log(line('-'));

  if (runStatus === 'waiting_for_human') {
    console.log('\nReason: every bound step in this workflow resolved to a human_in_the_loop');
    console.log('binding (Action Capability Binding v1) — XO recognized each action and');
    console.log('routed it correctly, but no step has claimed the underlying business action');
    console.log('(matching CRM records, validating brokerage, etc.) actually happened. A human');
    console.log('must now perform each escalated action for this workflow to truly complete.');
  }

  if (prepared.unboundStepCount > 0) {
    console.log(`\n${prepared.unboundStepCount} step(s) could not be bound to any executable strategy and were excluded from the graph — see "Steps" above.`);
  }
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  process.exit(1);
});
