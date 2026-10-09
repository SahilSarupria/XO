import type { XoirGraph, XoirNode } from '@xo/xoir';
import { XoirNodeId } from '@xo/xoir';
import type { CapabilityExecutionDeclaration } from '@xo/types';
import {
  buildSemanticCapabilityContract,
  extractContractFromPropertyBag,
  STANDARD_BINDING_RESOLVERS,
  resolveCapabilityBinding,
  type SemanticCapabilityContract,
  type CapabilityBinding,
  type BindingOutcome,
} from '@xo/capability-contract';
import type {
  AuditWorkflowOptions,
  CandidateWorkflow,
  ExecutabilityBlocker,
  ProvenDependency,
  StepAuthority,
  StepExecutabilityReport,
  StrategyCategory,
  StrategyEvidenceSummary,
  SuggestiveOrdering,
  WorkflowExecutabilityReport,
  WorkflowExecutabilityStatus,
} from './types.js';
import { getCapabilityName, getEmbeddedContractId } from './capability-node.js';

// P0.9B Step 2: previously two local consts + a local array; now the one
// canonical `STANDARD_BINDING_RESOLVERS` (`@xo/capability-contract`).
const standardResolvers = STANDARD_BINDING_RESOLVERS;

function getDeclaration(
  capabilityId: string,
  declarations?: ReadonlyMap<string, CapabilityExecutionDeclaration> | Record<string, CapabilityExecutionDeclaration>,
): CapabilityExecutionDeclaration | undefined {
  if (!declarations) return undefined;
  if (declarations instanceof Map) {
    return declarations.get(capabilityId);
  }
  return (declarations as Record<string, CapabilityExecutionDeclaration>)[capabilityId];
}

function auditStep(
  workflowStep: CandidateWorkflow['steps'][number],
  graph: XoirGraph,
  options: AuditWorkflowOptions,
): StepExecutabilityReport {
  const capabilityId = workflowStep.capabilityId;
  const nodeResult = graph.getNode(XoirNodeId(capabilityId));
  const node: XoirNode | undefined = nodeResult.ok ? nodeResult.value : undefined;

  const minConfidence = options.minStepConfidence ?? 0;
  const decl = getDeclaration(capabilityId, options.capabilityExecutionDeclarations);

  // 1. Contract extraction/building
  let contract: SemanticCapabilityContract | undefined;
  if (node) {
    const extracted = extractContractFromPropertyBag(node.properties);
    if (extracted.ok) {
      contract = extracted.value;
    } else {
      const contractResult = buildSemanticCapabilityContract(graph, XoirNodeId(capabilityId));
      if (contractResult.ok) {
        contract = contractResult.value;
      }
    }
  }

  const contractId = contract?.id ?? workflowStep.contractId ?? (node ? getEmbeddedContractId(node) : undefined);

  // 2. Execution Mode & Eligibility
  const declaredMode = decl?.mode;
  const hasModelEligibility = declaredMode === 'model';
  const hasHybridEligibility = declaredMode === 'hybrid' && Array.isArray(decl?.hybridSteps) && decl.hybridSteps.length > 0;

  // 3. Binding Resolution via capability-contract resolvers
  let bindingOutcome: BindingOutcome | undefined;
  let resolvedBinding: CapabilityBinding | undefined;
  let hasDeterministicEvidence = false;
  let hasHitlEvidence = false;
  let hasUnparseableExceptions = false;

  if (contract) {
    // Check unparseable exception conditions on rules
    hasUnparseableExceptions = contract.rules.some((r) => r.exceptionConditions.length > 0);

    bindingOutcome = resolveCapabilityBinding(contract, standardResolvers);
    if (bindingOutcome.status === 'resolved') {
      resolvedBinding = bindingOutcome.binding;
      if (resolvedBinding.implementationClass === 'deterministic_rule') {
        hasDeterministicEvidence = true;
      } else if (resolvedBinding.implementationClass === 'human_in_the_loop') {
        hasHitlEvidence = true;
      }
    }
  }

  // 4. Strategy Category Classification
  let category: StrategyCategory = 'insufficient';
  let details = 'No authoritative execution strategy evidence found for capability.';

  if (hasDeterministicEvidence) {
    category = 'deterministic';
    details = `Grounded in ${contract?.rules.length ?? 0} structured deterministic rule(s); binding "${resolvedBinding?.id}" resolved cleanly.`;
  } else if (hasHitlEvidence) {
    category = 'hitl';
    details = `Grounded in ${contract?.actionKnowledgeRefs.length ?? 0} operational action knowledge node(s); binding "${resolvedBinding?.id}" resolved to human_in_the_loop.`;
  } else if (hasModelEligibility) {
    category = 'model';
    details = `Manifest explicitly declares mode "model".`;
  } else if (hasHybridEligibility) {
    category = 'hybrid';
    details = `Manifest explicitly declares mode "hybrid" with ${decl?.hybridSteps?.length ?? 0} step(s).`;
  } else {
    category = 'insufficient';
    if (!contract) {
      details = `Missing semantic capability contract for capability node "${capabilityId}".`;
    } else if (hasUnparseableExceptions) {
      details = `Contract contains unparsed exception conditions that prevent deterministic execution.`;
    } else if (contract.rules.length > 0) {
      details = `Contract contains ${contract.rules.length} rule(s) but deterministic condition parsing failed.`;
    } else {
      details = `Ruleless contract has no linked operational action knowledge references (actionKnowledgeRefs is empty).`;
    }
  }

  const strategyEvidence: StrategyEvidenceSummary = {
    category,
    hasDeterministicEvidence,
    hasHitlEvidence,
    hasModelEligibility,
    hasHybridEligibility,
    details,
  };

  // 5. Blockers Identification
  const stepBlockers: ExecutabilityBlocker[] = [];

  if (!contract) {
    stepBlockers.push({
      kind: 'missing_contract',
      description: `No semantic capability contract available for capability "${capabilityId}".`,
      capabilityId,
    });
  }

  if (hasUnparseableExceptions) {
    stepBlockers.push({
      kind: 'unparseable_exception_conditions',
      description: `Capability "${capabilityId}" contains unparsed exception conditions that block deterministic compilation.`,
      capabilityId,
    });
  }

  if (category === 'insufficient') {
    stepBlockers.push({
      kind: 'unresolved_strategy',
      description: `Capability "${capabilityId}" has no resolved execution strategy or manifest model eligibility.`,
      capabilityId,
    });
  }

  if (workflowStep.confidence < minConfidence) {
    stepBlockers.push({
      kind: 'low_confidence_step',
      description: `Step confidence (${workflowStep.confidence}) falls below configured minimum threshold (${minConfidence}).`,
      capabilityId,
    });
  }

  // 6. Authority Determination
  let authority: StepAuthority = 'insufficient';

  if (stepBlockers.some((b) => b.kind === 'unparseable_exception_conditions' || b.kind === 'low_confidence_step')) {
    authority = 'blocked';
  } else if (category === 'deterministic' || category === 'hitl') {
    authority = 'proven';
  } else if (category === 'model' || category === 'hybrid') {
    authority = 'eligible';
  } else {
    authority = 'insufficient';
  }

  const bindingId = resolvedBinding?.id ?? decl?.bindingId;

  return {
    capabilityId,
    capabilityName: workflowStep.capabilityName,
    ...(contractId !== undefined ? { contractId } : {}),
    ...(bindingId !== undefined ? { bindingId } : {}),
    strategyEvidence,
    evidenceRefs: workflowStep.evidence,
    confidence: workflowStep.confidence,
    authority,
    blockers: stepBlockers,
  };
}

/**
 * Audits a `CandidateWorkflow` and its supporting `XoirGraph` to produce a
 * comprehensive `WorkflowExecutabilityReport`.
 *
 * Answers:
 * "What execution strategy evidence exists for each step, what is actually
 * proven, and what is still missing?"
 *
 * Pure and non-destructive: does NOT execute workflows, synthesize control
 * flow, or modify Runtime R1-R6 strategy routing.
 */
export function auditWorkflowExecutability(
  workflow: CandidateWorkflow,
  graph: XoirGraph,
  options: AuditWorkflowOptions = {},
): WorkflowExecutabilityReport {
  const stepsReport = workflow.steps.map((step) => auditStep(step, graph, options));

  // Extract proven dependencies from CandidateWorkflowStep rationale
  const provenDependencies: ProvenDependency[] = [];
  const suggestiveOrdering: SuggestiveOrdering[] = [];
  const seenProven = new Set<string>();
  const seenSuggestive = new Set<string>();

  for (const step of workflow.steps) {
    for (const dep of step.rationale.orderedAfter) {
      if (dep.evidenceStrength === 'source_derived') {
        const key = `${dep.capabilityId}->${step.capabilityId}:${dep.viaEdgeKind}:source_derived_ordering`;
        if (!seenSuggestive.has(key)) {
          seenSuggestive.add(key);
          suggestiveOrdering.push({
            fromCapabilityId: dep.capabilityId,
            toCapabilityId: step.capabilityId,
            kind: 'source_derived_ordering',
            explanation: dep.explanation,
          });
        }
      } else {
        const key = `${dep.capabilityId}->${step.capabilityId}:${dep.viaEdgeKind}`;
        if (!seenProven.has(key)) {
          seenProven.add(key);
          provenDependencies.push({
            fromCapabilityId: dep.capabilityId,
            toCapabilityId: step.capabilityId,
            viaEdgeKind: dep.viaEdgeKind,
            explanation: dep.explanation,
          });
        }
      }
    }

    if (step.rationale.tieBroken) {
      const key = `${step.capabilityId}:ambiguous_precedence`;
      if (!seenSuggestive.has(key)) {
        seenSuggestive.add(key);
        suggestiveOrdering.push({
          fromCapabilityId: step.capabilityId,
          toCapabilityId: step.capabilityId,
          kind: 'ambiguous_precedence',
          explanation: `Step position for "${step.capabilityId}" was resolved via tie-break, not a proven dependency edge.`,
        });
      }
    }
  }

  // Collect workflow-level blockers
  const workflowBlockers: ExecutabilityBlocker[] = [];

  // 1. Gather all step-level blockers
  for (const stepReport of stepsReport) {
    for (const blocker of stepReport.blockers) {
      workflowBlockers.push(blocker);
    }
  }

  // 2. Map CandidateWorkflow gaps into blockers
  for (const gap of workflow.gaps) {
    if (gap.kind === 'circular_dependency') {
      workflowBlockers.push({
        kind: 'circular_dependency',
        description: gap.description,
      });
    } else if (gap.kind === 'conflicting_capabilities') {
      workflowBlockers.push({
        kind: 'conflicting_capability',
        description: gap.description,
      });
    } else if (gap.kind === 'declared_dependency_unresolved') {
      workflowBlockers.push({
        kind: 'declared_dependency_unresolved',
        description: gap.description,
      });
    } else if (gap.kind === 'ambiguous_precedence') {
      workflowBlockers.push({
        kind: 'ambiguous_precedence',
        description: gap.description,
      });
    } else if (gap.kind === 'source_order_only') {
      workflowBlockers.push({
        kind: 'ambiguous_precedence',
        description: `Precedence relies on document source sequence (${gap.description}); unproven runtime execution dependency.`,
      });
    }
  }

  // Determine Workflow-Level Executability Status
  const isSemanticallyInvalid = workflowBlockers.some(
    (b) => b.kind === 'circular_dependency' || b.kind === 'conflicting_capability' || b.kind === 'declared_dependency_unresolved',
  );

  let status: WorkflowExecutabilityStatus = 'not_executable_yet';

  if (isSemanticallyInvalid) {
    status = 'semantically_invalid';
  } else {
    const allStepsAuthorized = stepsReport.every((s) => s.authority === 'proven' || s.authority === 'eligible');
    const noUnresolvedBlockers = workflowBlockers.length === 0;

    if (allStepsAuthorized && noUnresolvedBlockers) {
      status = 'executable_candidate';
    } else {
      status = 'not_executable_yet';
    }
  }

  return {
    workflowId: workflow.id,
    status,
    steps: stepsReport,
    provenDependencies,
    suggestiveOrdering,
    gaps: workflow.gaps,
    blockers: workflowBlockers,
  };
}
