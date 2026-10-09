import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { KnowledgeGraph, KnowledgeProvenance } from '../knowledge/types.js';
import type { ExperienceUnit } from '../semantic/types.js';
import type { CapabilityCategory, CapabilityRelationType, CapabilitySignature } from './types.js';

/**
 * A capability not yet merged/deduplicated or assigned its final id —
 * one extractor's opinion about one capability found in one
 * `ExperienceUnit`. `merge.ts` groups these across every unit and every
 * extractor into final `Capability` records. Mirrors
 * `../knowledge/extractor-types.ts#CandidateKnowledgeNode`'s shape and
 * role exactly, for the same reasons.
 */
export interface CandidateCapability {
  readonly localId: string;
  readonly category: CapabilityCategory;
  readonly name: string;
  readonly description: string;
  readonly confidence: number;
  readonly provenance: KnowledgeProvenance;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** P0.9A area B (Semantic I/O independence): genuine structured type info (e.g. `{amount: "number"}`) for a subset of `inputs`, populated only by `structured-operation-extractor.ts` from a real OpenAPI/JSON-Schema `type:` — never guessed from a name or description. Absent for every prose/PDF-derived candidate. */
  readonly inputTypes?: Readonly<Record<string, string>>;
  readonly requiredKnowledgeNodeIds: readonly string[];
  readonly relatedConcepts: readonly string[];
  readonly invocationHints: readonly string[];
  readonly examples: readonly string[];
  readonly signature: CapabilitySignature;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sourceUnitId: string;
  /** P0.9A area A: mirrors `../knowledge/extractor-types.ts`'s `CandidateKnowledgeNode.extractorName` — the extractor's own stable `.name` (e.g. `'rule-based'`, `'structured-operation'`, `'ai'`) that produced this candidate. */
  readonly extractorName?: string;
}

export interface CandidateCapabilityEdgeRef {
  readonly type: CapabilityRelationType;
  readonly fromLocalId: string;
  readonly toLocalId: string;
  readonly confidence: number;
  readonly provenance: KnowledgeProvenance;
}

export interface CapabilityExtractionResult {
  readonly capabilities: readonly CandidateCapability[];
  readonly edges: readonly CandidateCapabilityEdgeRef[];
}

/**
 * `knowledgeGraph` is passed alongside the unit so an extractor can link
 * a capability to the knowledge nodes it operates on/relates to
 * (`requiredKnowledgeNodeIds`, `relatedConcepts`) — Stage 5 consuming
 * Stage 4's own output, per the compiler spec's input list.
 */
export interface CapabilityExtractor {
  readonly name: string;
  extract(unit: ExperienceUnit, knowledgeGraph: KnowledgeGraph): Promise<Result<CapabilityExtractionResult, XoError>>;
}
