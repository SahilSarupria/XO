import { err, ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { AiCapabilityLayer } from '@xo/ai-core';
import type { KnowledgeGraph, KnowledgeProvenance } from '../knowledge/types.js';
import type { ExperienceUnit } from '../semantic/types.js';
import { CAPABILITY_VERBS } from './capability-lexicon.js';
import { UNKNOWN_SIGNATURE, type CapabilityCategory } from './types.js';
import type { CandidateCapability, CapabilityExtractionResult, CapabilityExtractor } from './extractor-types.js';

/**
 * `@xo/ai-core`'s `extractCapabilities` output has no category field of
 * its own (see that package's `capabilities/capabilities.ts`) — this
 * reuses `capability-lexicon.ts`'s verb table against the AI's returned
 * name/description as a best-effort guess, falling back to `action`
 * (the most generic known category) rather than inventing a false
 * `custom:` type for something that may well be a known category the
 * lexicon just didn't happen to phrase-match.
 */
function guessCategory(name: string, description: string): CapabilityCategory {
  const combined = `${name} ${description}`.toLowerCase();
  for (const [verb, category] of Object.entries(CAPABILITY_VERBS)) {
    if (combined.includes(verb)) return category;
  }
  return 'action';
}

/**
 * Calls `@xo/ai-core#extractCapabilities` — the only way this package
 * talks to an AI provider for this stage, per the compiler spec's "must
 * ONLY call @xo/ai-core through a single abstraction." Produces no
 * edges: `@xo/ai-core`'s capability-extraction output has no
 * relationship field of its own (unlike its `extractKnowledge`
 * capability) — `relationship-builder.ts` is where every candidate,
 * AI-sourced or rule-based, gets its relationships from, centrally.
 */
export class AiCapabilityExtractor implements CapabilityExtractor {
  readonly name = 'ai';

  constructor(
    private readonly aiCore: AiCapabilityLayer,
    private readonly domainHint?: string,
  ) {}

  async extract(unit: ExperienceUnit, knowledgeGraph: KnowledgeGraph): Promise<Result<CapabilityExtractionResult, XoError>> {
    const response = await this.aiCore.extractCapabilities({
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

    const capabilities: CandidateCapability[] = response.value.output.capabilities.map((item, index) => {
      const firstOffsets = item.evidenceExcerptOffsets[0];
      const provenance: KnowledgeProvenance = {
        experienceUnitId: unit.id,
        documentPath: unit.provenance.documentPath,
        pages: unit.provenance.pages,
        sectionPath: unit.provenance.sectionPath,
        charOffsetRange: firstOffsets ? [firstOffsets[0], firstOffsets[1]] : undefined,
        confidence: item.confidence,
      };
      const mentionedNodes = knowledgeGraph.nodes.filter((n) => n.canonicalLabel.length >= 3 && (item.description.includes(n.canonicalLabel) || item.name.includes(n.canonicalLabel)));
      return {
        localId: `ai-${index}`,
        category: guessCategory(item.name, item.description),
        name: item.name,
        description: item.description,
        confidence: item.confidence,
        provenance,
        inputs: [],
        outputs: [],
        requiredKnowledgeNodeIds: mentionedNodes.map((n) => n.id),
        relatedConcepts: mentionedNodes.filter((n) => n.semanticType === 'concept').map((n) => n.canonicalLabel),
        invocationHints: [],
        examples: [],
        signature: UNKNOWN_SIGNATURE,
        metadata: {},
        sourceUnitId: unit.id,
      };
    });

    return ok({ capabilities, edges: [] });
  }
}
