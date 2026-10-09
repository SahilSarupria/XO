import { ErrorCode, XoError } from '@xo/errors';
import { fromJson, type XoirGraph, type XoirGraphJson } from '@xo/xoir';
import {
  composeWorkflows,
  auditWorkflowExecutability,
  auditWorkflowDataFlow,
  type CandidateWorkflow,
  type ExecutabilityBlocker,
  type WorkflowDataFlowReport,
  type WorkflowExecutabilityReport,
  type WorkflowExecutabilityStatus,
} from '@xo/workflow-composer';
import { RuntimeCapabilityRegistry, prepareCandidateWorkflowForExecution, type PrepareCandidateWorkflowResult } from '@xo/runtime';

/**
 * Workflow discovery/resolution over ONE stored compilation's persisted
 * compiled graph. Everything here is a thin call into the existing,
 * unmodified `@xo/workflow-composer` (`composeWorkflows`,
 * `auditWorkflowExecutability`, `auditWorkflowDataFlow`) and
 * `@xo/runtime` (`prepareCandidateWorkflowForExecution`) — this file
 * owns no composition, audit, or binding logic of its own, and never
 * fabricates a workflow, a step, or an executability status.
 *
 * Determinism: `composeWorkflows`'s ids are content-derived (a hash of
 * the sorted capability ids), so the same compiled graph always yields
 * the same workflow ids and step order — which is what lets a persisted
 * `WorkflowExecutionRecord` re-derive the same workflow later (after a
 * restart) from just `(compilationId, workflowId)`.
 */

export interface ComposedCompilation {
  readonly graph: XoirGraph;
  readonly workflows: readonly CandidateWorkflow[];
}

export function composeCompilationWorkflows(compiledGraphJson: unknown, fixedTimestamp: string): { readonly ok: true; readonly value: ComposedCompilation } | { readonly ok: false; readonly error: XoError } {
  const graphResult = fromJson(compiledGraphJson as XoirGraphJson);
  if (!graphResult.ok) return { ok: false, error: new XoError(graphResult.error.code, graphResult.error.message) };
  const graph = graphResult.value;
  // A fixed `now` keeps `CandidateWorkflow.generatedAt` deterministic (it is never exposed by this API, but a deterministic composition is easier to reason about and test).
  const composed = composeWorkflows(graph, { now: () => fixedTimestamp });
  if (!composed.ok) return { ok: false, error: new XoError(composed.error.code as never, composed.error.message) };
  return { ok: true, value: { graph, workflows: composed.value } };
}

export interface ResolvedWorkflow {
  readonly workflow: CandidateWorkflow;
  readonly audit: WorkflowExecutabilityReport;
  readonly dataFlow: WorkflowDataFlowReport;
  readonly prepared: PrepareCandidateWorkflowResult;
  /** The registry `prepared` registered every bound step's binding into — a fresh, private registry per call (never shared across requests or workflows). */
  readonly registry: RuntimeCapabilityRegistry;
  /** `audit.status === 'executable_candidate'` AND every step bound. The only condition under which a workflow may be started. */
  readonly executable: boolean;
  readonly notExecutableReasons: readonly string[];
}

/** Runs the audit + data-flow audit + bridge preparation for one composed workflow — the exact three calls `apps/cli`'s `workflow-pipeline.ts` makes, in the same order. */
export function resolveWorkflow(graph: XoirGraph, workflow: CandidateWorkflow): ResolvedWorkflow {
  const audit = auditWorkflowExecutability(workflow, graph);
  const dataFlow = auditWorkflowDataFlow(workflow, graph);
  const registry = new RuntimeCapabilityRegistry();
  const prepared = prepareCandidateWorkflowForExecution(workflow, graph, registry);

  const reasons: string[] = [];
  if (workflow.steps.length === 0) reasons.push('workflow has no steps');
  if (audit.status !== 'executable_candidate') {
    reasons.push(`executability audit status is "${audit.status}"`);
    for (const blocker of audit.blockers) reasons.push(`${blocker.kind}${blocker.capabilityId !== undefined ? ` (${blocker.capabilityId})` : ''}: ${blocker.description}`);
  }
  for (const step of prepared.steps) {
    if (step.status === 'unbound') reasons.push(`step "${step.capabilityId}" could not be bound to an executable capability: ${step.reason ?? 'no reason reported'}`);
  }
  return { workflow, audit, dataFlow, prepared, registry, executable: reasons.length === 0, notExecutableReasons: reasons };
}

export function findWorkflow(composed: ComposedCompilation, workflowId: string): CandidateWorkflow | undefined {
  return composed.workflows.find((w) => w.id === workflowId);
}

/** The single place `WORKFLOW_NOT_EXECUTABLE` is raised for a workflow that exists but may not be started. `context` carries the audit's own blockers verbatim. */
export function workflowNotExecutableError(workflowId: string, compilationId: string, resolved: ResolvedWorkflow): XoError {
  return new XoError(ErrorCode.WORKFLOW_NOT_EXECUTABLE, `workflow "${workflowId}" in compilation "${compilationId}" is not executable: ${resolved.notExecutableReasons[0] ?? 'unknown reason'}`, {
    context: {
      workflowId,
      compilationId,
      executabilityStatus: resolved.audit.status satisfies WorkflowExecutabilityStatus,
      reasons: resolved.notExecutableReasons,
      blockers: resolved.audit.blockers.map((b: ExecutabilityBlocker) => ({ kind: b.kind, description: b.description, ...(b.capabilityId !== undefined ? { capabilityId: b.capabilityId } : {}) })),
    },
  });
}

// ---------------------------------------------------------------------------
// API-safe wire view
// ---------------------------------------------------------------------------

export interface WorkflowStepView {
  readonly order: number;
  readonly stepId: string;
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  /** `'deterministic_rule' | 'human_in_the_loop'` when the bridge could bind the step; absent when `bound` is false. */
  readonly executionClass?: string;
  readonly bound: boolean;
  readonly unboundReason?: string;
  /** The audit's `StepAuthority`: `proven | eligible | insufficient | blocked`. */
  readonly authority: string;
  readonly confidence: number;
  /** Has THIS workspace approved this capability (P0.5)? Required for every step before a workflow may start. */
  readonly approved: boolean;
  readonly inputs: readonly { readonly name: string; readonly runtimeKey: string; readonly semanticType: string; readonly required: boolean }[];
  readonly outputs: readonly { readonly name: string; readonly runtimeKey: string; readonly semanticType: string }[];
  readonly evidence: readonly { readonly documentPath: string; readonly locator?: string; readonly pages?: readonly number[] }[];
  readonly orderedAfter: readonly { readonly capabilityId: string; readonly evidenceStrength: string; readonly viaEdgeKind: string }[];
}

export interface WorkflowView {
  readonly workflowId: string;
  readonly compilationId: string;
  readonly sourceId?: string;
  readonly name: string;
  readonly description: string;
  /** Verbatim `WorkflowExecutabilityStatus` from `auditWorkflowExecutability` — never upgraded or reinterpreted. */
  readonly status: WorkflowExecutabilityStatus;
  /** `status === 'executable_candidate'` AND every step bound. Only an `executable` workflow can be started. */
  readonly executable: boolean;
  readonly notExecutableReasons: readonly string[];
  readonly blockers: readonly { readonly kind: string; readonly description: string; readonly capabilityId?: string }[];
  readonly requiresHumanDecision: boolean;
  readonly confidence: number;
  readonly gaps: readonly { readonly kind: string; readonly description: string; readonly involvedCapabilityIds: readonly string[] }[];
  readonly steps: readonly WorkflowStepView[];
  readonly dataFlow: {
    /** Every `'proven'` binding the existing data-flow audit found; `wired: true` when the runtime bridge will actually transfer the producer's value at execution time (producer bound as `deterministic_rule` and both steps bound). */
    readonly provenBindings: readonly { readonly producerCapabilityId: string; readonly outputParameterName: string; readonly consumerCapabilityId: string; readonly inputParameterName: string; readonly wired: boolean }[];
    readonly suggestiveBindingCount: number;
    readonly unboundInputCount: number;
  };
  readonly provenDependencies: readonly { readonly fromCapabilityId: string; readonly toCapabilityId: string; readonly viaEdgeKind: string }[];
  readonly suggestiveOrdering: readonly { readonly fromCapabilityId: string; readonly toCapabilityId: string; readonly kind: string }[];
  readonly processGrouping?: { readonly sectionPath: readonly string[]; readonly capabilityCount: number };
}

export function buildWorkflowView(compilationId: string, sourceId: string | undefined, resolved: ResolvedWorkflow, approvedCapabilityIds: ReadonlySet<string>): WorkflowView {
  const { workflow, audit, dataFlow, prepared } = resolved;
  const wired = new Set(prepared.wiredInjections.map((b) => `${b.producerCapabilityId}|${b.outputParameterName}|${b.consumerCapabilityId}|${b.inputParameterName}`));

  const steps: WorkflowStepView[] = workflow.steps.map((step) => {
    const bridgeStep = prepared.steps.find((s) => s.capabilityId === step.capabilityId);
    const auditStep = audit.steps.find((s) => s.capabilityId === step.capabilityId);
    return {
      order: step.order,
      stepId: step.id,
      capabilityId: step.capabilityId,
      name: step.capabilityName,
      description: step.description,
      ...(bridgeStep?.contractId !== undefined ? { contractId: bridgeStep.contractId } : step.contractId !== undefined ? { contractId: step.contractId } : {}),
      ...(bridgeStep?.bindingId !== undefined ? { bindingId: bridgeStep.bindingId } : {}),
      ...(bridgeStep?.status === 'bound' && bridgeStep.implementationClass !== undefined ? { executionClass: bridgeStep.implementationClass } : {}),
      bound: bridgeStep?.status === 'bound',
      ...(bridgeStep?.status === 'unbound' && bridgeStep.reason !== undefined ? { unboundReason: bridgeStep.reason } : {}),
      authority: auditStep?.authority ?? 'insufficient',
      confidence: step.confidence,
      approved: approvedCapabilityIds.has(step.capabilityId),
      inputs: (bridgeStep?.inputs ?? []).map((p) => ({ name: p.name, runtimeKey: p.runtimeKey, semanticType: p.semanticType ?? 'unknown', required: p.required === true })),
      outputs: (bridgeStep?.outputs ?? []).map((p) => ({ name: p.name, runtimeKey: p.runtimeKey, semanticType: p.semanticType ?? 'unknown' })),
      evidence: step.evidence.map((e) => ({ documentPath: e.documentPath, ...(e.locator !== undefined ? { locator: e.locator } : {}), ...(e.pages !== undefined ? { pages: e.pages } : {}) })),
      orderedAfter: step.rationale.orderedAfter.map((o) => ({ capabilityId: o.capabilityId, evidenceStrength: o.evidenceStrength, viaEdgeKind: o.viaEdgeKind })),
    };
  });

  return {
    workflowId: workflow.id,
    compilationId,
    ...(sourceId !== undefined ? { sourceId } : {}),
    name: workflow.name,
    description: workflow.description,
    status: audit.status,
    executable: resolved.executable,
    notExecutableReasons: resolved.notExecutableReasons,
    blockers: audit.blockers.map((b) => ({ kind: b.kind, description: b.description, ...(b.capabilityId !== undefined ? { capabilityId: b.capabilityId } : {}) })),
    requiresHumanDecision: workflow.requiresHumanDecision,
    confidence: workflow.confidence,
    gaps: workflow.gaps.map((g) => ({ kind: g.kind, description: g.description, involvedCapabilityIds: g.involvedCapabilityIds })),
    steps,
    dataFlow: {
      provenBindings: dataFlow.bindings
        .filter((b) => b.status === 'proven')
        .map((b) => ({
          producerCapabilityId: b.producerCapabilityId,
          outputParameterName: b.outputParameterName,
          consumerCapabilityId: b.consumerCapabilityId,
          inputParameterName: b.inputParameterName,
          wired: wired.has(`${b.producerCapabilityId}|${b.outputParameterName}|${b.consumerCapabilityId}|${b.inputParameterName}`),
        })),
      suggestiveBindingCount: dataFlow.bindings.filter((b) => b.status === 'suggestive').length,
      unboundInputCount: dataFlow.unboundInputs.length,
    },
    provenDependencies: audit.provenDependencies.map((d) => ({ fromCapabilityId: d.fromCapabilityId, toCapabilityId: d.toCapabilityId, viaEdgeKind: d.viaEdgeKind })),
    suggestiveOrdering: audit.suggestiveOrdering.map((s) => ({ fromCapabilityId: s.fromCapabilityId, toCapabilityId: s.toCapabilityId, kind: s.kind })),
    ...(workflow.processGrouping !== undefined ? { processGrouping: { sectionPath: workflow.processGrouping.sectionPath, capabilityCount: workflow.processGrouping.capabilityCount } } : {}),
  };
}
