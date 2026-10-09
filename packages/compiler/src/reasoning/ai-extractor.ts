import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { AiCapabilityLayer, DecisionGraphExtractionOutput, ReasoningExtractionOutput, ConstraintExtractionOutput } from '@xo/ai-core';
import type { ExperienceUnit } from '../semantic/types.js';
import type { KnowledgeProvenance } from '../knowledge/types.js';
import type { CandidateReasoningEdgeRef, CandidateReasoningNode, ReasoningExtractionResult, ReasoningExtractor } from './extractor-types.js';

const AI_EDGE_CONFIDENCE = 0.7;

/**
 * Calls @xo/ai-core's already-existing extractReasoning, extractDecisionGraph, and
 * extractConstraints capabilities. All three capabilities, schemas, and prompts already
 * existed before Stage 7 - this extractor adds no new surface to @xo/ai-core, only a
 * mapping from its existing output shapes onto Stage 7's candidate node/edge types.
 *
 * Schema validation, retry, and provider fallback happen inside AiCapabilityLayer itself.
 *
 * Deliberately NOT mapped (documented, not silently dropped): tradeoffs, failureModes,
 * confidenceBoundaries - no clean 1:1 correspondence to a ReasoningNodeType.
 */
export class AiReasoningExtractor implements ReasoningExtractor {
  readonly name = 'ai';

  constructor(
    private readonly aiCore: AiCapabilityLayer,
    private readonly domainHint?: string,
    private readonly focusQuestion?: string,
  ) {}

  async extract(unit: ExperienceUnit): Promise<Result<ReasoningExtractionResult, XoError>> {
    const excerpt = {
      text: unit.content,
      documentPath: unit.provenance.documentPath,
      section: unit.provenance.sectionPath.join(' > '),
      ...(unit.provenance.pages[0] !== undefined ? { page: unit.provenance.pages[0] } : {}),
    };
    const baseProvenance = (confidence: number): KnowledgeProvenance => ({
      experienceUnitId: unit.id,
      documentPath: unit.provenance.documentPath,
      pages: unit.provenance.pages,
      sectionPath: unit.provenance.sectionPath,
      charOffsetRange: undefined,
      confidence,
    });

    const [reasoningResult, decisionResult, constraintResult] = await Promise.all([
      this.aiCore.extractReasoning({ input: this.focusQuestion !== undefined ? { focusQuestion: this.focusQuestion } : {}, excerpt, traceId: unit.id }),
      this.aiCore.extractDecisionGraph({ input: this.focusQuestion !== undefined ? { focusQuestion: this.focusQuestion } : {}, excerpt, traceId: unit.id }),
      this.aiCore.extractConstraints({ input: this.domainHint !== undefined ? { domainHint: this.domainHint } : {}, excerpt, traceId: unit.id }),
    ]);

    const nodes: CandidateReasoningNode[] = [];
    const edges: CandidateReasoningEdgeRef[] = [];

    if (reasoningResult.ok) mapReasoningOutput(reasoningResult.value.output, unit.id, baseProvenance, nodes, edges);
    if (decisionResult.ok) mapDecisionGraphOutput(decisionResult.value.output, unit.id, baseProvenance, nodes, edges);
    if (constraintResult.ok) mapConstraintOutput(constraintResult.value.output, unit.id, baseProvenance, nodes);

    if (!reasoningResult.ok && !decisionResult.ok && !constraintResult.ok) {
      return err(reasoningResult.error);
    }

    return ok({ nodes, edges });
  }
}

function mapReasoningOutput(
  output: ReasoningExtractionOutput,
  sourceUnitId: string,
  baseProvenance: (confidence: number) => KnowledgeProvenance,
  nodes: CandidateReasoningNode[],
  edges: CandidateReasoningEdgeRef[],
): void {
  for (const step of output.steps) {
    nodes.push({
      localId: `step-${step.id}`,
      nodeType: 'justification',
      canonicalLabel: `${step.premise} => ${step.conclusion}`,
      rationale: step.premise,
      outcome: step.conclusion,
      exceptionConditions: [],
      confidence: step.confidence,
      provenance: baseProvenance(step.confidence),
      metadata: { source: 'ai:extractReasoning' },
      sourceUnitId,
    });
  }

  output.exceptions.forEach((exception, index) => {
    nodes.push({
      localId: `exception-${index}`,
      nodeType: 'exception',
      canonicalLabel: `unless ${exception.condition}: ${exception.deviation}`,
      condition: exception.condition,
      action: exception.deviation,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractReasoning' },
      sourceUnitId,
    });
  });

  output.alternativePaths.forEach((path, index) => {
    const localId = `alt-path-${index}`;
    nodes.push({
      localId,
      nodeType: 'alternative',
      canonicalLabel: `${path.description} (when ${path.whenApplicable})`,
      outcome: path.description,
      condition: path.whenApplicable,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractReasoning' },
      sourceUnitId,
    });
    for (const stepId of path.stepIds) {
      edges.push({ type: 'supports', fromLocalId: `step-${stepId}`, toLocalId: localId, confidence: AI_EDGE_CONFIDENCE, provenance: baseProvenance(AI_EDGE_CONFIDENCE) });
    }
  });
}

function mapDecisionGraphOutput(
  output: DecisionGraphExtractionOutput,
  sourceUnitId: string,
  baseProvenance: (confidence: number) => KnowledgeProvenance,
  nodes: CandidateReasoningNode[],
  edges: CandidateReasoningEdgeRef[],
): void {
  for (const decision of output.decisions) {
    nodes.push({
      localId: `decision-${decision.id}`,
      nodeType: 'decision',
      canonicalLabel: decision.question,
      outcome: decision.question,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractDecisionGraph' },
      sourceUnitId,
    });
    for (const depId of decision.dependsOnDecisionIds) {
      edges.push({ type: 'depends_on', fromLocalId: `decision-${decision.id}`, toLocalId: `decision-${depId}`, confidence: AI_EDGE_CONFIDENCE, provenance: baseProvenance(AI_EDGE_CONFIDENCE) });
    }
  }

  output.branches.forEach((branch, index) => {
    const localId = `branch-${index}`;
    nodes.push({
      localId,
      nodeType: 'decision',
      canonicalLabel: `${branch.condition} => ${branch.outcome}`,
      condition: branch.condition,
      outcome: branch.outcome,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractDecisionGraph' },
      sourceUnitId,
    });
    edges.push({ type: 'condition_of', fromLocalId: localId, toLocalId: `decision-${branch.decisionId}`, confidence: AI_EDGE_CONFIDENCE, provenance: baseProvenance(AI_EDGE_CONFIDENCE) });
    if (branch.leadsToDecisionId !== undefined) {
      edges.push({ type: 'leads_to', fromLocalId: localId, toLocalId: `decision-${branch.leadsToDecisionId}`, confidence: AI_EDGE_CONFIDENCE, provenance: baseProvenance(AI_EDGE_CONFIDENCE) });
    }
  });

  output.escalationPaths.forEach((escalation, index) => {
    nodes.push({
      localId: `escalation-${index}`,
      nodeType: 'escalation',
      canonicalLabel: `${escalation.triggerCondition} => escalate to ${escalation.escalateTo}`,
      condition: escalation.triggerCondition,
      action: escalation.escalateTo,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractDecisionGraph' },
      sourceUnitId,
    });
  });

  output.riskThresholds.forEach((threshold, index) => {
    nodes.push({
      localId: `risk-${index}`,
      nodeType: 'risk_threshold',
      canonicalLabel: `${threshold.metric}: ${threshold.thresholdDescription} => ${threshold.aboveThresholdAction}`,
      condition: threshold.thresholdDescription,
      action: threshold.aboveThresholdAction,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractDecisionGraph', metric: threshold.metric },
      sourceUnitId,
    });
  });

  output.fallbacks.forEach((fallback, index) => {
    const localId = `fallback-${index}`;
    nodes.push({
      localId,
      nodeType: 'rule',
      canonicalLabel: `${fallback.whenDecisionFails} fails => ${fallback.fallbackAction}`,
      condition: `${fallback.whenDecisionFails} fails`,
      action: fallback.fallbackAction,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractDecisionGraph' },
      sourceUnitId,
    });
    if (output.decisions.some((d) => d.id === fallback.whenDecisionFails)) {
      edges.push({ type: 'condition_of', fromLocalId: localId, toLocalId: `decision-${fallback.whenDecisionFails}`, confidence: AI_EDGE_CONFIDENCE, provenance: baseProvenance(AI_EDGE_CONFIDENCE) });
    }
  });
}

function mapConstraintOutput(output: ConstraintExtractionOutput, sourceUnitId: string, baseProvenance: (confidence: number) => KnowledgeProvenance, nodes: CandidateReasoningNode[]): void {
  output.constraints.forEach((constraint, index) => {
    nodes.push({
      localId: `constraint-${index}`,
      nodeType: 'policy',
      canonicalLabel: constraint.rule,
      action: constraint.rule,
      exceptionConditions: [],
      confidence: AI_EDGE_CONFIDENCE,
      provenance: baseProvenance(AI_EDGE_CONFIDENCE),
      metadata: { source: 'ai:extractConstraints', severity: constraint.severity, constraintKind: constraint.kind, applicability: constraint.applicability },
      sourceUnitId,
    });
  });
}
