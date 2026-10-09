import { fileURLToPath } from 'node:url';
import type { CandidateWorkflowStep } from '@xo/workflow-composer';
import type { CandidateWorkflowStepBridgeResult } from '@xo/runtime';
import type { CommandResult } from '../../command-result.js';
import { failWith, ok } from '../../command-result.js';
import { runWorkflowPipeline, describeStepOutput, type WorkflowPipelineOptions } from './workflow-pipeline.js';

/**
 * Known demo scenarios. Each pins a real, checked-in fixture path so
 * `xo demo <scenario>` needs no arguments to run — but every scenario
 * still goes through the exact same {@link runWorkflowPipeline} any
 * other source would, so there is nothing scenario-specific about
 * compilation, composition, or execution, only about which file gets
 * handed in and (for `commercial-property` only) a labeled, synthetic
 * demo trigger payload.
 */
const SCENARIOS = {
  aastha: {
    fixture: '../../../../../examples/vertical-test/Aastha.pdf',
    label: 'Aastha — Insurance Operations & Procedures',
    /** No default trigger payload: the real Aastha workflow is HITL end
     * to end (see the milestone brief) — inventing input values for it
     * would misrepresent a document that has no deterministic rules to
     * feed. `--input` still works if the caller wants to try one. */
    defaultInput: undefined as Readonly<Record<string, unknown>> | undefined,
  },
  'commercial-property': {
    fixture: '../../../../../examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf',
    label: 'Commercial Property — Test Policy (deterministic demonstration)',
    /** A synthetic demo trigger payload — NOT extracted from the source
     * document, and always labeled as such in the output (see
     * `renderSourceSection`'s "demo trigger payload" line below). This
     * is the same mechanism `--input` always was (a real, user-suppliable
     * business-event payload merged unmodified into structured input,
     * per `workflow-pipeline.ts`'s doc comment); a demo command supplying
     * a default one is not fabricating document facts, it is choosing a
     * plausible caller-supplied event so the deterministic rules in this
     * fixture have something to evaluate against in an unattended demo.
     */
    defaultInput: {
      claim_amount: 15000,
      all_required_documents: 'present',
      loss_type: 'flood',
      flood_endorsement: 'none',
      policy: 'active',
      loss: 'fire',
      required_documents: 'present',
      manager_approval: 'granted',
      lossadjuster_assessment: 'complete',
      any_information_provided_in_claim: 'consistent',
      becoming_aware_loss: '2026-01-01',
      claim: 'claim_123',
    } as Readonly<Record<string, unknown>>,
  },
} as const;

export type DemoScenario = keyof typeof SCENARIOS;

export function isKnownScenario(value: string): value is DemoScenario {
  return Object.prototype.hasOwnProperty.call(SCENARIOS, value);
}

export function knownScenarioNames(): readonly string[] {
  return Object.keys(SCENARIOS);
}

export interface DemoOptions {
  readonly scenario: DemoScenario;
  /** Overrides the scenario's pinned fixture path — mainly for tests, which cannot rely on the repo-root-relative default resolving inside a temp dir. */
  readonly source?: string;
  readonly domainHint?: string;
  readonly workflowId?: string;
  readonly workflowIndex?: number;
  /** Overrides the scenario's default trigger payload (if any). Passing an explicit empty object suppresses the default entirely. */
  readonly input?: Readonly<Record<string, unknown>>;
  readonly json?: boolean;
}

function resolveScenarioSource(scenario: DemoScenario): string {
  return fileURLToPath(new URL(SCENARIOS[scenario].fixture, import.meta.url));
}

/**
 * `xo demo <scenario>` — the golden-path demonstration surface. Exactly
 * the same production pipeline as `xo workflow` ({@link runWorkflowPipeline}),
 * presented as five labeled sections (Source, Understanding, Capability
 * classification, Execution, Final summary) instead of `xo workflow`'s
 * denser single-pass listing. Adds no new compiler/contract/workflow/
 * runtime behavior — it only reorganizes the same {@link WorkflowPipelineOptions}
 * result the shared pipeline already produces, plus the `CompileSourcesResult`
 * fields (`sources`, `stats`) `xo workflow` doesn't currently surface.
 */
export async function demoCommand(options: DemoOptions): Promise<CommandResult> {
  const scenarioConfig = SCENARIOS[options.scenario];
  const source = options.source ?? resolveScenarioSource(options.scenario);
  const input = options.input ?? scenarioConfig.defaultInput;
  const usedDefaultInput = options.input === undefined && scenarioConfig.defaultInput !== undefined;

  const pipelineOptions: WorkflowPipelineOptions = {
    source,
    ...(options.domainHint !== undefined ? { domainHint: options.domainHint } : {}),
    ...(options.workflowId !== undefined ? { workflowId: options.workflowId } : {}),
    ...(options.workflowIndex !== undefined ? { workflowIndex: options.workflowIndex } : {}),
    ...(input !== undefined ? { input } : {}),
  };

  const result = await runWorkflowPipeline(pipelineOptions);
  if (!result.ok) return failWith(result.message);

  const { compiled, workflow, discoveredWorkflowCount, selectionRationale, dataFlow, prepared, stepResults, engineStatus, runStatus } = result;

  // Zip the composer's per-step evidence/confidence (`workflow.steps`)
  // with the bridge's per-step execution-class/contract/input-output
  // report (`prepared.steps`) — both keyed by `capabilityId`, neither
  // recomputed here.
  const composerStepById = new Map<string, CandidateWorkflowStep>(workflow.steps.map((s) => [s.capabilityId, s]));
  const bridgeSteps: readonly CandidateWorkflowStepBridgeResult[] = prepared.steps;

  const counts = {
    total: bridgeSteps.length,
    deterministic: bridgeSteps.filter((s) => s.implementationClass === 'deterministic_rule').length,
    hitl: bridgeSteps.filter((s) => s.implementationClass === 'human_in_the_loop').length,
    unresolved: bridgeSteps.filter((s) => s.status === 'unbound').length,
    // A "completed" step actually produced a real result from the executor
    // (deterministic rule evaluation — `{matched: true|false, ...}` — or any
    // other non-escalation result) — evaluating to `matched: false` is still
    // a completed, honest evaluation, not a failure. An escalation is
    // deliberately excluded here: see the acceptance criteria's "never claim
    // a human action occurred when it only escalated".
    completed: stepResults.filter((s) => s.output !== undefined && s.output.status !== 'escalation_required').length,
    escalated: stepResults.filter((s) => s.output?.status === 'escalation_required').length,
    failedOrBlocked: bridgeSteps.filter((s) => s.status === 'bound').length - stepResults.filter((s) => s.output !== undefined).length,
    provenBindings: dataFlow.bindings.filter((b) => b.status === 'proven').length,
    missingInputs: dataFlow.unboundInputs.length,
  };

  if (options.json) {
    return ok([
      JSON.stringify({
        scenario: options.scenario,
        source: { path: source, sources: compiled.sources, stats: compiled.stats },
        understanding: {
          workflowId: workflow.id,
          workflowName: workflow.name,
          selectionRationale,
          discoveredWorkflowCount,
          sourceSection: workflow.processGrouping?.sectionPath ?? null,
          gaps: workflow.gaps,
        },
        capabilities: bridgeSteps.map((s) => ({
          capabilityName: s.capabilityName,
          capabilityId: s.capabilityId,
          executionClass: s.status === 'bound' ? s.implementationClass : 'unresolved',
          contractId: s.contractId ?? null,
          confidence: composerStepById.get(s.capabilityId)?.confidence ?? null,
          evidence: composerStepById.get(s.capabilityId)?.evidence ?? [],
          inputs: s.inputs ?? [],
          outputs: s.outputs ?? [],
        })),
        execution: { engineStatus, status: runStatus, steps: stepResults, usedDefaultDemoInput: usedDefaultInput },
        summary: counts,
      }),
    ]);
  }

  const lines: string[] = [];
  const rule = (c = '=') => c.repeat(72);
  lines.push(rule(), `XO Demo — ${scenarioConfig.label}`, rule(), '');

  // --- Source -------------------------------------------------------
  lines.push('Source');
  for (const src of compiled.sources) {
    lines.push(`  file: ${src.sourcePath}  (${src.sourceType})`);
    lines.push(`  compilation: ${src.semanticExtractionAvailable ? 'extraction ran' : 'no semantic extraction available for this source type'}`);
    lines.push(`  trust/degradation status: ${src.qualityState ?? 'n/a (not a document source)'}`);
    lines.push(`  units contributed: ${src.unitCount}`);
  }
  lines.push(`  nodes: ${compiled.stats.nodeCount}   edges: ${compiled.stats.edgeCount}   capabilities: ${compiled.stats.nodesByKind['capability'] ?? 0}`);
  lines.push('');

  // --- Understanding --------------------------------------------------
  lines.push('Understanding');
  lines.push(`  workflow: ${workflow.name}`);
  lines.push(`  id: ${workflow.id}   confidence: ${workflow.confidence.toFixed(2)}`);
  lines.push(`  selected because: ${selectionRationale}  (${discoveredWorkflowCount} candidate workflow(s) discovered)`);
  if (workflow.processGrouping) lines.push(`  source section: ${workflow.processGrouping.sectionPath.join(' > ')}`);
  lines.push(`  steps (${workflow.steps.length}):`);
  for (const s of workflow.steps) {
    const evidenceLabel = s.evidence.length > 0 ? s.evidence.map((e) => `${e.documentPath}${e.locator ? `#${e.locator}` : ''}`).join(', ') : '(no per-step provenance recorded)';
    lines.push(`    ${s.order + 1}. ${s.capabilityName}   [provenance: ${evidenceLabel}]`);
  }
  if (workflow.gaps.length > 0) {
    lines.push('  gaps:');
    for (const g of workflow.gaps) lines.push(`    [${g.kind}] ${g.description}`);
  }
  lines.push('');

  // --- Capability classification --------------------------------------
  lines.push('Capability classification');
  for (const s of bridgeSteps) {
    const composerStep = composerStepById.get(s.capabilityId);
    const executionClass = s.status === 'bound' ? (s.implementationClass ?? 'bound') : 'unresolved';
    lines.push(`  ${s.capabilityName}`);
    lines.push(`    capabilityId: ${s.capabilityId}`);
    lines.push(`    executionClass: ${executionClass}`);
    lines.push(`    contractId: ${s.contractId ?? '(none)'}`);
    if (composerStep) {
      lines.push(`    confidence: ${composerStep.confidence.toFixed(2)}`);
      const evidenceLabel = composerStep.evidence.length > 0 ? composerStep.evidence.map((e) => `${e.documentPath}${e.locator ? `#${e.locator}` : ''}`).join(', ') : '(none recorded)';
      lines.push(`    provenance: ${evidenceLabel}`);
    }
    if (s.status === 'unbound') lines.push(`    reason: ${s.reason}`);
    if (s.inputs && s.inputs.length > 0) {
      lines.push('    inputs:');
      for (const p of s.inputs) {
        const injection = prepared.wiredInjections.find((w) => w.consumerCapabilityId === s.capabilityId && w.inputParameterName === p.name);
        const status = injection ? `injected (from ${injection.producerCapabilityId}.${injection.outputParameterName})` : input && Object.prototype.hasOwnProperty.call(input, p.runtimeKey) ? 'supplied' : 'MISSING';
        const nameLabel = p.name === p.runtimeKey ? p.name : `${p.name} [runtime key: ${p.runtimeKey}]`;
        lines.push(`      - ${nameLabel}  type: ${p.semanticType ?? 'unknown'}  derivedFrom: ${p.derivedFrom}  -> ${status}`);
      }
    } else {
      lines.push('    inputs: (none declared)');
    }
    if (s.outputs && s.outputs.length > 0) {
      lines.push('    outputs:');
      for (const p of s.outputs) lines.push(`      - ${p.name}  type: ${p.semanticType ?? 'unknown'}  derivedFrom: ${p.derivedFrom}`);
    } else {
      lines.push('    outputs: (none declared)');
    }
  }
  lines.push('');

  // --- Execution --------------------------------------------------------
  lines.push('Execution');
  if (usedDefaultInput) {
    lines.push(`  (using a synthetic demo trigger payload — NOT extracted from the source document: ${JSON.stringify(scenarioConfig.defaultInput)})`);
  }
  for (const s of stepResults) {
    const line = describeStepOutput(s.output);
    lines.push(`  ${s.capabilityName}: ${line}`);
    if (s.output?.status === 'escalation_required') {
      const reason = (s.output as Record<string, unknown>)['reason'];
      if (typeof reason === 'string') lines.push(`    reason: ${reason}`);
    }
  }
  for (const s of bridgeSteps) {
    if (s.status === 'unbound') lines.push(`  ${s.capabilityName}: UNRESOLVED — not executed  (${s.reason})`);
  }
  lines.push('');

  // --- Final summary ------------------------------------------------
  lines.push('Final summary');
  lines.push(`  total workflow steps:  ${counts.total}`);
  lines.push(`  deterministic steps:   ${counts.deterministic}`);
  lines.push(`  HITL steps:            ${counts.hitl}`);
  lines.push(`  unresolved steps:      ${counts.unresolved}`);
  lines.push(`  completed steps:       ${counts.completed}`);
  lines.push(`  escalated steps:       ${counts.escalated}`);
  lines.push(`  failed/blocked steps:  ${Math.max(0, counts.failedOrBlocked)}`);
  lines.push(`  proven data-flow bindings: ${counts.provenBindings}`);
  lines.push(`  missing inputs:        ${counts.missingInputs}`);
  lines.push('');
  lines.push(`Engine-level status: ${engineStatus}`);
  lines.push(`Workflow status:     ${runStatus}`);
  if (runStatus === 'waiting_for_human') {
    lines.push('  (at least one step requires a human action that has not happened yet — this is NOT a completed business outcome.)');
  }

  return { exitCode: runStatus === 'failed' ? 1 : 0, lines };
}
