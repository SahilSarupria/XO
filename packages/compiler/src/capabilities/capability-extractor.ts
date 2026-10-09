import type { AiCapabilityLayer } from '@xo/ai-core';
import type { Logger } from '@xo/logger';
import { AiCapabilityExtractor } from './ai-extractor.js';
import { HybridCapabilityExtractor } from './hybrid-extractor.js';
import type { CapabilityExtractor } from './extractor-types.js';
import { mergeCapabilities, type PerUnitCapabilityExtraction } from './merge.js';
import { buildCapabilityRelationships } from './relationship-builder.js';
import type { ExperienceDocument } from '../semantic/types.js';
import type { KnowledgeGraph } from '../knowledge/types.js';
import type { CapabilityGraph } from './types.js';

export interface CapabilityExtractionOptions {
  /** When supplied, `HybridCapabilityExtractor` additionally calls `@xo/ai-core#extractCapabilities` per unit; when omitted, extraction is rule-based only (still a correct, if lower-confidence, graph — "never fail compilation" per the Stage 5 brief). */
  readonly aiCore?: AiCapabilityLayer;
  readonly domainHint?: string;
  readonly logger?: Logger;
  /** Escape hatch for a caller that wants to supply its own `CapabilityExtractor` entirely (e.g. a test double), bypassing the default hybrid wiring. */
  readonly extractor?: CapabilityExtractor;
}

/**
 * Stage 5: turns Stage 3's `ExperienceDocument` plus Stage 4's
 * `KnowledgeGraph` into a `CapabilityGraph` — everything this XO can do.
 * Runs the configured extractor (default: `HybridCapabilityExtractor`)
 * over every `ExperienceUnit` independently (each with the *whole*
 * `KnowledgeGraph` available for cross-referencing), merges candidates
 * into deduplicated `Capability` records (`merge.ts`), then builds every
 * `CapabilityRelationship` and derives each capability's `dependencies`
 * (`relationship-builder.ts`).
 *
 * Deterministic given the same `ExperienceDocument`, the same
 * `KnowledgeGraph`, and the same extractor — see
 * `capability-extractor.test.ts`'s determinism tests, and
 * `../knowledge/knowledge-extractor.ts`'s doc comment for the identical
 * caveat about a live AI provider's own sampling behavior not being this
 * stage's to guarantee.
 */
export async function extractCapabilityGraph(experienceDocument: ExperienceDocument, knowledgeGraph: KnowledgeGraph, options: CapabilityExtractionOptions = {}): Promise<CapabilityGraph> {
  const extractor =
    options.extractor ??
    new HybridCapabilityExtractor(options.aiCore ? new AiCapabilityExtractor(options.aiCore, options.domainHint) : undefined, options.logger);

  const perUnit: PerUnitCapabilityExtraction[] = [];
  for (const unit of experienceDocument.units) {
    const result = await extractor.extract(unit, knowledgeGraph);
    const extraction = result.ok ? result.value : { capabilities: [], edges: [] };
    if (!result.ok) {
      options.logger?.warn('Capability extraction failed for a unit; it contributes no capabilities', { unitId: unit.id, error: result.error.message });
    }
    perUnit.push({ unit, extraction });
  }

  const mergeResult = mergeCapabilities(perUnit);
  const { capabilities, relationships } = buildCapabilityRelationships(perUnit, mergeResult);

  return { capabilities, relationships };
}
