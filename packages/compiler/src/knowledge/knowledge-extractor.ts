import type { AiCapabilityLayer } from '@xo/ai-core';
import type { Logger } from '@xo/logger';
import { AiKnowledgeExtractor } from './ai-extractor.js';
import { HybridKnowledgeExtractor } from './hybrid-extractor.js';
import type { KnowledgeExtractor } from './extractor-types.js';
import { mergeKnowledgeNodes, type PerUnitExtraction } from './merge.js';
import { buildKnowledgeEdges } from './relationship-builder.js';
import type { ExperienceDocument } from '../semantic/types.js';
import type { KnowledgeGraph } from './types.js';

export interface KnowledgeExtractionOptions {
  /** When supplied, `HybridKnowledgeExtractor` additionally calls `@xo/ai-core#extractKnowledge` per unit; when omitted, extraction is rule-based only (still a correct, if lower-confidence, graph). */
  readonly aiCore?: AiCapabilityLayer;
  readonly domainHint?: string;
  readonly logger?: Logger;
  /** Escape hatch for a caller that wants to supply its own `KnowledgeExtractor` entirely (e.g. a test double), bypassing the default hybrid wiring. */
  readonly extractor?: KnowledgeExtractor;
}

/**
 * Stage 4: turns Stage 3's `ExperienceDocument` into a `KnowledgeGraph`.
 * Runs the configured extractor (default: `HybridKnowledgeExtractor`,
 * rule-based always, AI-assisted when `options.aiCore` is supplied) over
 * every `ExperienceUnit` independently, merges the resulting candidates
 * into deduplicated `KnowledgeNode`s (`merge.ts`), then builds every
 * `KnowledgeEdge` (`relationship-builder.ts`).
 *
 * Deterministic given the same `ExperienceDocument` and the same
 * extractor: `merge.ts`'s node ids are content hashes over normalized
 * labels, never insertion order or randomness, so re-running produces a
 * byte-for-byte identical `KnowledgeGraph` — see
 * `knowledge-extractor.test.ts`'s determinism tests. (The one exception,
 * stated plainly rather than hidden: if `options.aiCore` is wired to a
 * real, live provider, that provider's own output is not itself
 * guaranteed deterministic across calls — determinism here covers this
 * stage's own logic, not a live LLM's sampling behavior. `@xo/ai-core`'s
 * deterministic-replay provider is what makes an end-to-end deterministic
 * test of the AI-assisted path possible — see this package's tests.)
 */
export async function extractKnowledgeGraph(experienceDocument: ExperienceDocument, options: KnowledgeExtractionOptions = {}): Promise<KnowledgeGraph> {
  const extractor =
    options.extractor ??
    new HybridKnowledgeExtractor(options.aiCore ? new AiKnowledgeExtractor(options.aiCore, options.domainHint) : undefined, options.logger);

  const perUnit: PerUnitExtraction[] = [];
  for (const unit of experienceDocument.units) {
    const result = await extractor.extract(unit);
    const extraction = result.ok ? result.value : { nodes: [], edges: [] };
    if (!result.ok) {
      options.logger?.warn('Knowledge extraction failed for a unit; it contributes no nodes', { unitId: unit.id, error: result.error.message });
    }
    perUnit.push({ unit, extraction });
  }

  const mergeResult = mergeKnowledgeNodes(perUnit);
  const edges = buildKnowledgeEdges(experienceDocument, perUnit, mergeResult);

  return { nodes: mergeResult.nodes, edges };
}
