import { brand, type Brand, type CapabilityExecutionDeclaration } from '@xo/types';
import type { XoirEdgeKind, XoirNodeId, XoirSourceRef } from '@xo/xoir';

/**
 * This package's own identifier space — distinct from `@xo/xoir`'s
 * `XoirNodeId`/`XoirGraphId` and from any registry-level id in
 * `@xo/types`. A `CandidateWorkflowId` identifies a *proposed* workflow,
 * never a published, executable artifact.
 */
export type CandidateWorkflowId = Brand<string, 'CandidateWorkflowId'>;
export const CandidateWorkflowId = (value: string): CandidateWorkflowId => brand(value);

export type CandidateWorkflowStepId = Brand<string, 'CandidateWorkflowStepId'>;
export const CandidateWorkflowStepId = (value: string): CandidateWorkflowStepId => brand(value);

/**
 * A minimal, lossless projection of the evidence this package already
 * finds sitting on a XOIR node (`XoirNodeMetadata.sourceRefs`) or,
 * transitively, on an embedded `SemanticCapabilityContract.sourceRefs`.
 * Deliberately a subset (not the full `XoirSourceRef`) — a candidate
 * workflow step cites *where* a capability came from, it does not need
 * every extraction-internal field (`experienceUnitId`, `sourceConfidence`)
 * to do that.
 */
export interface WorkflowEvidenceRef {
  readonly documentPath: string;
  readonly locator?: string;
  readonly pages?: readonly number[];
}

/** Narrows a full `XoirSourceRef` down to `WorkflowEvidenceRef` without inventing any field. */
export function toWorkflowEvidenceRef(ref: XoirSourceRef): WorkflowEvidenceRef {
  return {
    documentPath: ref.documentPath,
    ...(ref.locator !== undefined ? { locator: ref.locator } : {}),
    ...(ref.pages !== undefined ? { pages: ref.pages } : {}),
  };
}

/**
 * Why a step landed at its position. Always populated — a step with no
 * dependency evidence still gets a rationale explaining *that* (e.g. "no
 * precedence relationship found; placed by deterministic id order"),
 * because a silent default is exactly the kind of implicit guess this
 * module is required to avoid.
 */
export interface StepPrecedenceRationale {
  /** Capability ids (see `capabilityId` on `CandidateWorkflowStep`) whose steps this one was ordered after, and why. Empty when nothing in the composed set precedes this step. */
  readonly orderedAfter: readonly {
    readonly capabilityId: string;
    readonly viaEdgeKind: XoirEdgeKind;
    /** `'logical'` when `viaEdgeKind` is a proven dependency relationship (REQUIRES, PRODUCES, etc.); `'source_derived'` when it is Sequence Evidence (`custom:sequence`). */
    readonly evidenceStrength: 'logical' | 'source_derived';
    readonly explanation: string;
  }[];
  /** True when this step's position relative to at least one sibling was not fully determined by any relationship and was resolved by a documented, deterministic tie-break instead of a real precedence signal. A corresponding `WorkflowGap` of kind `'ambiguous_precedence'` is always also recorded on the owning workflow when this is true. */
  readonly tieBroken: boolean;
}

export interface CandidateWorkflowStep {
  readonly id: CandidateWorkflowStepId;
  /** 0-based position within `CandidateWorkflow.steps` — redundant with array order, carried explicitly so a consumer that reshuffles/filters steps doesn't lose the original position without noticing. */
  readonly order: number;
  /**
   * The XOIR capability node id this step refers to, reused verbatim.
   * This package never mints a new capability id and never renames one —
   * it only orders and annotates ids that already exist in the input
   * graph.
   */
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly description: string;
  readonly rationale: StepPrecedenceRationale;
  /** The embedded `SemanticCapabilityContract.id` this step's capability carries, when `@xo/compiler` embedded one (see `CapabilityNodeProps.semanticCapabilityContract`). Absent, not fabricated, when no contract was embedded. */
  readonly contractId?: string;
  /** This step's own confidence — the capability node's `metadata.confidence`, never recomputed or inflated by composition. */
  readonly confidence: number;
  readonly evidence: readonly WorkflowEvidenceRef[];
}

export type WorkflowGapKind =
  /** A capability node declares (via `CapabilityNodeProps.dependencies`) a dependency that either isn't in the composed scope or has no matching graph edge — the two representations disagree, so composition does not silently trust either one. */
  | 'declared_dependency_unresolved'
  /** Two or more steps have no precedence relationship (direct or transitive) between them; a deterministic tie-break was used to give them a concrete order, but that order is not a claim about which should really run first. */
  | 'ambiguous_precedence'
  /** A precedence cycle was found among the composed capabilities; no valid topological order exists for the cyclic subset, so it was placed using a documented deterministic fallback instead of a guessed order. */
  | 'circular_dependency'
  /** A `CONFLICTS_WITH` relationship exists between two composed capabilities; both are kept (this package never drops a discovered capability), but running them in the same workflow needs a human call. */
  | 'conflicting_capabilities'
  /** A composed capability's own confidence falls below the caller-supplied threshold (see `CompositionOptions.minStepConfidence`); it is still included, just flagged. */
  | 'low_confidence_capability'
  /** Two or more steps with no real precedence relationship between them were nonetheless placed in a specific relative order because document/source sequence evidence exists (a `COMPLEMENTS` edge — see `precedence.ts#SourceSequenceFact`); that order reflects where the source material presented them, not a proven execution dependency, and should be reviewed as such rather than trusted like a `REQUIRES`-derived order. */
  | 'source_order_only'
  /** At least one pair of adjacent steps in this workflow was ordered using Sequence Evidence (`custom:sequence`) rather than a proven logical dependency. */
  | 'source_derived_ordering';

export interface WorkflowGap {
  readonly kind: WorkflowGapKind;
  readonly description: string;
  readonly involvedCapabilityIds: readonly string[];
}

/**
 * Best-effort, evidence-only linkage from a `CandidateWorkflow` back to
 * the document section its steps were drawn from — the closest thing the
 * current XOIR representation has to an explicit "these capabilities
 * realize this process" edge (see this package's README, "Why there is
 * no single 'Reconciliation Process' workflow for a multi-section
 * source"). Attached only when every step in the workflow carries at
 * least one `sourceRefs` entry with the exact same non-empty
 * `sectionPath`, straight from `XoirSourceRef.sectionPath` — never
 * synthesized, truncated, or merged across differing section paths.
 */
export interface ProcessGroupingEvidence {
  /** The shared `XoirSourceRef.sectionPath`, verbatim, every step in this workflow traces back to. */
  readonly sectionPath: readonly string[];
  /**
   * The id of a `concept` node (subtype `process` or `action`) whose own
   * `sectionPath` matches this one and whose content textually matches
   * the section heading itself — i.e. the node that names this process
   * in the source, when Stage 4 happened to extract one. Never guessed
   * at or fabricated: absent whenever no such node exists, which is
   * common (see this package's README).
   */
  readonly processConceptNodeId?: string;
  /** Number of this workflow's steps that contributed to `sectionPath` agreeing (equal to `steps.length` today, since this field is only ever set when every step agrees). */
  readonly capabilityCount: number;
}

/**
 * One deterministically-composed proposal for how a set of existing
 * capabilities could be sequenced into a workflow. "Candidate" is load
 * bearing: this is a proposal a human or a later planning stage reviews,
 * not an executable artifact — see this package's README for the
 * relationship to `@xo/runtime`'s `WorkflowGraph`.
 */
export interface CandidateWorkflow {
  readonly id: CandidateWorkflowId;
  readonly name: string;
  readonly description: string;
  readonly steps: readonly CandidateWorkflowStep[];
  /** Every capability id considered for this specific candidate (equal to the set of `steps[].capabilityId`, kept as its own field for a caller that wants the set without mapping over steps). */
  readonly sourceCapabilityIds: readonly string[];
  readonly gaps: readonly WorkflowGap[];
  /** True whenever `gaps` contains anything that genuinely blocks unattended execution (`circular_dependency` or `conflicting_capabilities`) — `ambiguous_precedence` and `low_confidence_capability` alone do not set this, since a tie-broken order or a low-confidence step is still safe to *propose*, just not to blindly trust. */
  readonly requiresHumanDecision: boolean;
  /** The weakest link across `steps[].confidence` — a workflow is only as trustworthy as its least-trustworthy step. Deliberately not an average: an average would let one very confident step mask one that is barely more than a guess. */
  readonly confidence: number;
  readonly generatedAt: string;
  /** Present only when every step shares one exact, non-empty `sectionPath` — see {@link ProcessGroupingEvidence}. Absent (never fabricated) when steps come from different sections or carry no section path at all. */
  readonly processGrouping?: ProcessGroupingEvidence;
}

export interface CompositionOptions {
  /** Restricts composition to this subset of capability node ids present in the supplied graph. Defaults to every `capability`-kind node in the graph. */
  readonly capabilityNodeIds?: readonly XoirNodeId[];
  /**
   * Optional caller-supplied ordering evidence (e.g. document order, a
   * discovery-time sequence) used only as the *last-resort* deterministic
   * tie-break when two steps have no precedence relationship between
   * them. Never overrides a real relationship. Ids not present in this
   * list fall back to lexicographic capability-id order.
   */
  readonly precedenceHint?: readonly XoirNodeId[];
  /** Below this, a step is still included but flagged via a `'low_confidence_capability'` gap. Defaults to 0 (never flags). */
  readonly minStepConfidence?: number;
  readonly now?: () => string;
}

// ---------------------------------------------------------------------------
// Executability & Strategy Evidence Audit Report Types
// ---------------------------------------------------------------------------

export type WorkflowExecutabilityStatus =
  | 'executable_candidate'
  | 'not_executable_yet'
  | 'semantically_invalid';

export type StrategyCategory =
  | 'deterministic'
  | 'hitl'
  | 'model'
  | 'hybrid'
  | 'insufficient';

export type StepAuthority =
  | 'proven'
  | 'eligible'
  | 'insufficient'
  | 'blocked';

export type ExecutabilityBlockerKind =
  | 'unresolved_strategy'
  | 'missing_contract'
  | 'missing_input_schema'
  | 'unresolved_binding'
  | 'unparseable_exception_conditions'
  | 'ambiguous_precedence'
  | 'unproven_data_dependency'
  | 'circular_dependency'
  | 'conflicting_capability'
  | 'unsupported_control_flow'
  | 'unauthorized_execution_mode'
  | 'low_confidence_step'
  | 'declared_dependency_unresolved';

export interface ExecutabilityBlocker {
  readonly kind: ExecutabilityBlockerKind;
  readonly description: string;
  readonly capabilityId?: string;
}

export interface StrategyEvidenceSummary {
  readonly category: StrategyCategory;
  readonly hasDeterministicEvidence: boolean;
  readonly hasHitlEvidence: boolean;
  readonly hasModelEligibility: boolean;
  readonly hasHybridEligibility: boolean;
  readonly details: string;
}

export interface ProvenDependency {
  readonly fromCapabilityId: string;
  readonly toCapabilityId: string;
  readonly viaEdgeKind: XoirEdgeKind;
  readonly explanation: string;
}

export interface SuggestiveOrdering {
  readonly fromCapabilityId: string;
  readonly toCapabilityId: string;
  readonly kind: 'source_order_only' | 'source_derived_ordering' | 'ambiguous_precedence';
  readonly explanation: string;
}

export interface StepExecutabilityReport {
  readonly capabilityId: string;
  readonly capabilityName: string;
  readonly contractId?: string;
  readonly bindingId?: string;
  readonly strategyEvidence: StrategyEvidenceSummary;
  readonly evidenceRefs: readonly WorkflowEvidenceRef[];
  readonly confidence: number;
  readonly authority: StepAuthority;
  readonly blockers: readonly ExecutabilityBlocker[];
}

export interface WorkflowExecutabilityReport {
  readonly workflowId: CandidateWorkflowId;
  readonly status: WorkflowExecutabilityStatus;
  readonly steps: readonly StepExecutabilityReport[];
  readonly provenDependencies: readonly ProvenDependency[];
  readonly suggestiveOrdering: readonly SuggestiveOrdering[];
  readonly gaps: readonly WorkflowGap[];
  readonly blockers: readonly ExecutabilityBlocker[];
}

export interface AuditWorkflowOptions {
  /** Optional caller-supplied manifest capability declarations or execution declarations mapped by capabilityId. */
  readonly capabilityExecutionDeclarations?: ReadonlyMap<string, CapabilityExecutionDeclaration> | Record<string, CapabilityExecutionDeclaration>;
  /** Below this confidence threshold, step authority becomes 'blocked' due to low confidence. Defaults to 0. */
  readonly minStepConfidence?: number;
}

export type StepDataBindingStatus =
  | 'proven'
  | 'suggestive'
  | 'unbound';

export interface StepDataBinding {
  readonly producerStepId: CandidateWorkflowStepId;
  readonly producerCapabilityId: string;
  readonly outputParameterName: string;

  readonly consumerStepId: CandidateWorkflowStepId;
  readonly consumerCapabilityId: string;
  readonly inputParameterName: string;

  readonly status: StepDataBindingStatus;

  readonly evidenceKind:
    | 'explicit_contract_match'
    | 'concept_produces_consumes'
    | 'name_similarity_only'
    | 'unproven';

  readonly rationale: string;
}

export interface WorkflowDataFlowReport {
  readonly bindings: readonly StepDataBinding[];

  readonly unboundInputs: readonly {
    readonly stepId: CandidateWorkflowStepId;
    readonly capabilityId: string;
    readonly parameterName: string;
    readonly derivedFrom:
      | 'declared'
      | 'rule_derived'
      | 'unknown';
  }[];
}

