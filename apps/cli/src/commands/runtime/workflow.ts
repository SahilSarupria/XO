import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { runWorkflowPipeline, describeStepOutput, type WorkflowPipelineOptions } from './workflow-pipeline.js';

export interface WorkflowOptions extends WorkflowPipelineOptions {
  readonly json?: boolean;
}

/**
 * `xo workflow <source>` — the CLI's seam into the already-proven,
 * already-tested multi-step path ({@link runWorkflowPipeline}: real
 * `compileSources` -> `composeWorkflows`/`auditWorkflowExecutability`/
 * `auditWorkflowDataFlow` -> `prepareCandidateWorkflowForExecution` ->
 * `WorkflowExecutor`/`RuntimeCapabilityExecutor`) that `xo run` never
 * calls. This command performs no compilation, binding-resolution, or
 * execution logic of its own — every one of the production calls is
 * made exactly once inside `workflow-pipeline.ts`, in the same sequence
 * the `examples/vertical-test/*-e2e.mts` scripts already proved works;
 * this file only turns the shared pipeline's result into
 * `CommandResult` lines/JSON. `xo demo` (`demo.ts`) is the same
 * pipeline with a different, more narrative presentation — neither
 * file duplicates the other's rendering logic or the pipeline itself.
 *
 * Deliberately does NOT accept any way to supply a demo/binding
 * override (unlike the example scripts, which needed one to execute a
 * JSON/OpenAPI operation's arithmetic — see their own doc comments):
 * this is the production CLI path, and only capabilities that resolve
 * through the real, existing resolvers
 * (`StructuredComparisonBindingResolver`/`ActionEscalationBindingResolver`)
 * ever execute here. A capability this command reports `unresolved` is
 * being reported honestly, not worked around.
 */
export async function workflowCommand(options: WorkflowOptions): Promise<CommandResult> {
  const result = await runWorkflowPipeline(options);
  if (!result.ok) return failWith(result.message);

  const { workflow, selectionRationale: rationale, execReport, dataFlow, prepared, stepResults, engineStatus, runStatus } = result;

  if (options.json) {
    return ok([
      JSON.stringify({
        selection: { workflowId: workflow.id, rationale },
        workflow: {
          id: workflow.id,
          name: workflow.name,
          confidence: workflow.confidence,
          requiresHumanDecision: workflow.requiresHumanDecision,
          processGrouping: workflow.processGrouping ?? null,
          gaps: workflow.gaps,
        },
        steps: prepared.steps.map((s) => ({
          ...s,
          inputs: s.inputs?.map((p) => ({ ...p, ...parameterStatus(s.capabilityId, p.name, p.runtimeKey, prepared.wiredInjections, options.input) })),
        })),
        executability: { status: execReport.status, blockers: execReport.blockers, steps: execReport.steps },
        dataFlow: { bindings: dataFlow.bindings, unboundInputs: dataFlow.unboundInputs },
        execution: { engineStatus, status: runStatus, steps: stepResults },
      }),
    ]);
  }

  const lines: string[] = [];
  lines.push(`Workflow: ${workflow.name}  (id: ${workflow.id})`);
  lines.push(`  selected because: ${rationale}`);
  lines.push(`  confidence: ${workflow.confidence.toFixed(2)}  steps: ${workflow.steps.length}`);
  if (workflow.processGrouping) lines.push(`  source section: ${workflow.processGrouping.sectionPath.join(' > ')}`);
  if (workflow.gaps.length > 0) {
    lines.push('  gaps:');
    for (const g of workflow.gaps) lines.push(`    [${g.kind}] ${g.description}`);
  }

  lines.push('', 'Steps:');
  for (const s of prepared.steps) {
    lines.push(`  [${s.status === 'bound' ? (s.implementationClass ?? 'bound') : 'UNRESOLVED'}] ${s.capabilityName}`);
    lines.push(`      capabilityId: ${s.capabilityId}${s.contractId ? `  contractId: ${s.contractId}` : ''}`);
    if (s.status === 'unbound') lines.push(`      reason: ${s.reason}`);
    if (s.inputs && s.inputs.length > 0) {
      lines.push('      inputs:');
      for (const p of s.inputs) {
        const { status, from } = parameterStatus(s.capabilityId, p.name, p.runtimeKey, prepared.wiredInjections, options.input);
        const statusLabel = status === 'injected' ? `injected (from ${from})` : status === 'supplied' ? 'supplied' : 'MISSING';
        const nameLabel = p.name === p.runtimeKey ? p.name : `${p.name}  [runtime key: ${p.runtimeKey}]`;
        lines.push(`        - ${nameLabel}  type: ${p.semanticType ?? 'unknown'}  derivedFrom: ${p.derivedFrom}  -> ${statusLabel}`);
      }
    } else if (s.contractId) {
      lines.push('      inputs: (none declared)');
    }
    if (s.outputs && s.outputs.length > 0) {
      lines.push('      outputs:');
      for (const p of s.outputs) lines.push(`        - ${p.name}  type: ${p.semanticType ?? 'unknown'}  derivedFrom: ${p.derivedFrom}`);
    }
  }

  lines.push('', 'Data-flow report (auditWorkflowDataFlow, unmodified):');
  const proven = dataFlow.bindings.filter((b) => b.status === 'proven');
  const suggestive = dataFlow.bindings.filter((b) => b.status === 'suggestive');
  lines.push(`  proven bindings:     ${proven.length}`);
  for (const b of proven) lines.push(`    ${b.producerCapabilityId}.${b.outputParameterName} -> ${b.consumerCapabilityId}.${b.inputParameterName}  [${b.evidenceKind}]`);
  lines.push(`  suggestive bindings: ${suggestive.length} (never auto-injected)`);
  lines.push(`  unbound inputs:      ${dataFlow.unboundInputs.length}`);

  lines.push('', 'Execution (real WorkflowExecutor + RuntimeCapabilityExecutor):');
  for (const s of stepResults) {
    lines.push(`  ${s.capabilityName}: ${describeStepOutput(s.output)}`);
  }
  lines.push('', `Engine-level status: ${engineStatus}`);
  lines.push(`Workflow status:     ${runStatus}`);
  if (runStatus === 'waiting_for_human') {
    lines.push('  (at least one step requires a human action that has not happened yet — this is NOT a completed business outcome.)');
  }

  return { exitCode: runStatus === 'failed' ? 1 : 0, lines };
}

function parameterStatus(
  stepCapabilityId: string,
  paramName: string,
  runtimeKey: string,
  wiredInjections: readonly { consumerCapabilityId: string; inputParameterName: string; producerCapabilityId: string; outputParameterName: string }[],
  suppliedInput: Readonly<Record<string, unknown>> | undefined,
): { status: 'injected' | 'supplied' | 'missing'; from?: string } {
  const injection = wiredInjections.find((w) => w.consumerCapabilityId === stepCapabilityId && w.inputParameterName === paramName);
  if (injection) return { status: 'injected', from: `${injection.producerCapabilityId}.${injection.outputParameterName}` };
  if (suppliedInput && Object.prototype.hasOwnProperty.call(suppliedInput, runtimeKey)) return { status: 'supplied' };
  return { status: 'missing' };
}
