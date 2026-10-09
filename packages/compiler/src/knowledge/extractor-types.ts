import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { ExperienceUnit } from '../semantic/types.js';
import type { KnowledgeEdgeType, KnowledgeNodeType, KnowledgeProvenance } from './types.js';

/**
 * A node not yet merged/deduplicated or assigned its final id — one
 * extractor's opinion about one surface form found in one
 * `ExperienceUnit`. `merge.ts` groups these across every unit and every
 * extractor into final `KnowledgeNode`s.
 *
 * `localId` is scoped to `(sourceUnitId, extractor call)` — unique enough
 * for that same call's `CandidateKnowledgeEdgeRef`s to reference it, but
 * meaningless outside that scope (never a final node id, never shown to
 * a caller).
 */
export interface CandidateKnowledgeNode {
  readonly localId: string;
  readonly semanticType: KnowledgeNodeType;
  readonly label: string;
  readonly confidence: number;
  readonly provenance: KnowledgeProvenance;
  readonly metadata: Readonly<Record<string, string>>;
  /** True for the one candidate per unit that represents "this unit's own idea" (as opposed to an entity mentioned within it) — `relationship-builder.ts` uses this to find the right endpoint when projecting Stage 3's unit-level relationships onto the knowledge graph. */
  readonly isUnitPrimary: boolean;
  readonly sourceUnitId: string;
  /** P0.9A area A: the extractor's own stable `.name` (e.g. `'rule-based'`, `'ai'`) that produced this candidate. Stamped by `hybrid-extractor.ts` right after each sub-extractor returns, never invented here. Optional: a directly-constructed candidate (as several tests do) with no stamped name simply never contributes to a merged node's `producedBy` — see `merge.ts`. */
  readonly extractorName?: string;
}

/** An edge between two of THIS SAME extraction call's candidate nodes, referenced by their (unit-scoped) `localId` — resolved into a real `KnowledgeEdge` between final node ids once `merge.ts` knows what those candidates merged into. */
export interface CandidateKnowledgeEdgeRef {
  readonly type: KnowledgeEdgeType;
  readonly fromLocalId: string;
  readonly toLocalId: string;
  readonly confidence: number;
  readonly provenance: KnowledgeProvenance;
}

export interface ExtractionResult {
  readonly nodes: readonly CandidateKnowledgeNode[];
  readonly edges: readonly CandidateKnowledgeEdgeRef[];
}

export interface KnowledgeExtractor {
  readonly name: string;
  extract(unit: ExperienceUnit): Promise<Result<ExtractionResult, XoError>>;
}
