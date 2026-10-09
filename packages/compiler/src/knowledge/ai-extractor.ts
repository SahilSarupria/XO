import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { AiCapabilityLayer } from '@xo/ai-core';
import type { ExperienceUnit } from '../semantic/types.js';
import type { CandidateKnowledgeNode, CandidateKnowledgeEdgeRef, ExtractionResult, KnowledgeExtractor } from './extractor-types.js';
import type { KnowledgeEdgeType, KnowledgeNodeType, KnowledgeProvenance } from './types.js';

function mapKnowledgeItemType(type: 'fact' | 'definition' | 'rule' | 'concept'): KnowledgeNodeType {
  switch (type) {
    case 'definition':
      return 'definition';
    case 'rule':
      return 'constraint';
    case 'fact':
    case 'concept':
      return 'concept';
  }
}

// ai-core's KnowledgeRelationType ('depends_on' | 'derived_from' | 'contradicts' | 'references') is already a subset of our own KnowledgeEdgeType — no translation table needed, just a type-level assertion that the subset holds.
function mapRelationType(type: 'depends_on' | 'derived_from' | 'contradicts' | 'references'): KnowledgeEdgeType {
  return type;
}

/**
 * Calls `@xo/ai-core`'s `extractKnowledge` capability — the ONLY way this
 * package talks to an AI provider, per the compiler spec's "do not call
 * providers directly." Never talks to OpenAI/Anthropic/etc. itself, never
 * even knows such vendors exist; `@xo/ai-core`'s own README documents
 * that its five real provider adapters aren't live-verified in this
 * sandbox (no network/API credentials) — that constraint applies here
 * too, transitively.
 *
 * Produces no `isUnitPrimary` node (`RuleBasedKnowledgeExtractor` always
 * supplies that, regardless of whether this extractor also runs — see
 * `hybrid-extractor.ts`) — every node here is an *additional*,
 * typically higher-confidence, candidate.
 */
export class AiKnowledgeExtractor implements KnowledgeExtractor {
  readonly name = 'ai';

  constructor(
    private readonly aiCore: AiCapabilityLayer,
    private readonly domainHint?: string,
  ) {}

  async extract(unit: ExperienceUnit): Promise<Result<ExtractionResult, XoError>> {
    const response = await this.aiCore.extractKnowledge({
      input: this.domainHint !== undefined ? { domainHint: this.domainHint } : {},
      excerpt: {
        text: unit.content,
        documentPath: unit.provenance.documentPath,
        section: unit.provenance.sectionPath.join(' > '),
        ...(unit.provenance.pages[0] !== undefined ? { page: unit.provenance.pages[0] } : {}),
      },
      traceId: unit.id,
    });

    if (!response.ok) return err(response.error);

    const baseProvenance = (confidence: number): KnowledgeProvenance => ({
      experienceUnitId: unit.id,
      documentPath: unit.provenance.documentPath,
      pages: unit.provenance.pages,
      sectionPath: unit.provenance.sectionPath,
      charOffsetRange: undefined, // @xo/ai-core's extractKnowledge does not report offsets — see this package's README, "Known limitations"
      confidence,
    });

    const nodes: CandidateKnowledgeNode[] = response.value.output.items.map((item) => ({
      localId: item.id,
      semanticType: mapKnowledgeItemType(item.type),
      label: item.statement,
      confidence: item.confidence,
      provenance: baseProvenance(item.confidence),
      metadata: { domain: item.domain },
      isUnitPrimary: false,
      sourceUnitId: unit.id,
    }));

    // ai-core's relationship items carry no per-edge confidence of their own (unlike its `items`, which each report one); 0.7 is a fixed, documented stand-in reflecting "AI-asserted, not independently verified" — see this package's README.
    const AI_RELATIONSHIP_CONFIDENCE = 0.7;
    const edges: CandidateKnowledgeEdgeRef[] = response.value.output.relationships.map((rel) => ({
      type: mapRelationType(rel.type),
      fromLocalId: rel.fromItemId,
      toLocalId: rel.toItemId,
      confidence: AI_RELATIONSHIP_CONFIDENCE,
      provenance: baseProvenance(AI_RELATIONSHIP_CONFIDENCE),
    }));

    return ok({ nodes, edges });
  }
}
