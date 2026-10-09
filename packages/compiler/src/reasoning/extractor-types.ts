import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { ExperienceUnit } from '../semantic/types.js';
import type { KnowledgeProvenance } from '../knowledge/types.js';
import type { ReasoningEdgeType, ReasoningNodeType } from './types.js';
import type { StructuredAction, StructuredCondition, StructuredExceptionCondition } from '@xo/capability-contract';

export interface CandidateReasoningNode {
  readonly localId: string;
  readonly nodeType: ReasoningNodeType;
  readonly canonicalLabel: string;
  readonly condition?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly rationale?: string;
  readonly exceptionConditions: readonly string[];
  readonly confidence: number;
  readonly provenance: KnowledgeProvenance;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sourceUnitId: string;
  /** Phase 2 — see `ReasoningNode.structuredCondition`'s doc comment (`./types.ts`); this is the same field, one stage earlier, before merge (`merge.ts`) folds same-match-key candidates together. */
  readonly structuredCondition?: StructuredCondition;
  readonly structuredAction?: StructuredAction;
  readonly structuredExceptions?: readonly StructuredExceptionCondition[];
}

export interface CandidateReasoningEdgeRef {
  readonly type: ReasoningEdgeType;
  readonly fromLocalId: string;
  readonly toLocalId: string;
  readonly confidence: number;
  readonly provenance: KnowledgeProvenance;
}

export interface ReasoningExtractionResult {
  readonly nodes: readonly CandidateReasoningNode[];
  readonly edges: readonly CandidateReasoningEdgeRef[];
}

export interface ReasoningExtractor {
  readonly name: string;
  extract(unit: ExperienceUnit): Promise<Result<ReasoningExtractionResult, XoError>>;
}
