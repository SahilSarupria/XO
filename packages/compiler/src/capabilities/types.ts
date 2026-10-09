import type { Brand } from '@xo/types';
import type { KnowledgeNodeId, KnowledgeProvenance } from '../knowledge/types.js';

export type CapabilityId = Brand<string, 'CapabilityId'>;

/** Open-ended via `custom:<name>`, matching the pattern every prior stage's type union uses. */
export type KnownCapabilityCategory =
  | 'action'
  | 'analysis'
  | 'generation'
  | 'transformation'
  | 'retrieval'
  | 'communication'
  | 'workflow'
  | 'planning'
  | 'reasoning'
  | 'search'
  | 'classification'
  | 'extraction'
  | 'summarization'
  | 'translation'
  | 'validation'
  | 'execution';
export type CapabilityCategory = KnownCapabilityCategory | `custom:${string}`;

export type KnownCapabilityRelationType = 'depends_on' | 'invokes' | 'produces' | 'consumes' | 'extends' | 'requires' | 'enables' | 'conflicts_with' | 'complements';
export type CapabilityRelationType = KnownCapabilityRelationType | `custom:${string}`;

/**
 * A machine-readable capability signature — added per the Stage 5 brief's
 * closing recommendation, so Stages 6-9 (Reasoning, Decision Graph,
 * Constraints, and eventually a runtime/execution layer) have the shape
 * they need without this model needing to change again later. Every
 * field that this stage's extractors cannot honestly infer from text
 * alone is `'unknown'` (or an empty array) rather than a guessed value —
 * see the package README's "Known limitations."
 */
export interface CapabilityParameter {
  readonly name: string;
  readonly description: string;
}

export type Determinism = 'deterministic' | 'non_deterministic' | 'unknown';
export type ExecutionMode = 'sync' | 'async' | 'unknown';
export type CostEstimate = 'low' | 'medium' | 'high' | 'unknown';

export interface CapabilitySignature {
  readonly inputs: readonly CapabilityParameter[];
  readonly outputs: readonly CapabilityParameter[];
  readonly sideEffects: readonly string[];
  readonly requiredResources: readonly string[];
  readonly determinism: Determinism;
  readonly idempotent: boolean | 'unknown';
  readonly executionMode: ExecutionMode;
  readonly estimatedCost: CostEstimate;
}

export const UNKNOWN_SIGNATURE: CapabilitySignature = {
  inputs: [],
  outputs: [],
  sideEffects: [],
  requiredResources: [],
  determinism: 'unknown',
  idempotent: 'unknown',
  executionMode: 'unknown',
  estimatedCost: 'unknown',
};

/**
 * One discovered capability of the XO. Reuses `KnowledgeProvenance`
 * (Stage 4) verbatim for `provenance`, per the Stage 5 brief — every
 * capability traces back to the same document/page/section/unit shape a
 * knowledge node does, rather than a parallel provenance model.
 */
export interface Capability {
  readonly id: CapabilityId;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly category: CapabilityCategory;
  readonly confidence: number;
  readonly provenance: readonly KnowledgeProvenance[];
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** P0.9A area B: mirrors `extractor-types.ts`'s `CandidateCapability.inputTypes` — see `merge.ts` for how conflicting candidate values are handled (dropped, never guessed at). */
  readonly inputTypes?: Readonly<Record<string, string>>;
  readonly dependencies: readonly CapabilityId[];
  readonly requiredKnowledgeNodeIds: readonly KnowledgeNodeId[];
  readonly relatedConcepts: readonly string[];
  readonly requiredPermissions: readonly string[]; // empty for now — no permission model exists yet
  readonly invocationHints: readonly string[];
  readonly examples: readonly string[];
  readonly signature: CapabilitySignature;
  readonly metadata: Readonly<Record<string, string>>;
  /** P0.9A area A: mirrors `../knowledge/types.ts`'s `KnowledgeNode.producedBy` — set only when every merged candidate (`merge.ts`) came from the same extractor. */
  readonly producedBy?: string;
}

export interface CapabilityRelationship {
  readonly id: string;
  readonly type: CapabilityRelationType;
  readonly fromCapabilityId: CapabilityId;
  readonly toCapabilityId: CapabilityId;
  readonly confidence: number;
  readonly provenance: readonly KnowledgeProvenance[];
}

/**
 * Stage 5's output artifact. Immutable, deterministic, hashable
 * (`graph.ts#hashCapabilityGraph`), serializable
 * (`graph.ts#serializeCapabilityGraph`/`deserializeCapabilityGraph`) — the
 * same shape of guarantee `@xo/xoir` and Stage 4's `KnowledgeGraph`
 * already provide, applied to "everything this XO can do" instead of
 * "everything this XO knows."
 */
export interface CapabilityGraph {
  readonly capabilities: readonly Capability[];
  readonly relationships: readonly CapabilityRelationship[];
}
