import type { AiCapabilityLayer } from '@xo/ai-core';
import type { Logger } from '@xo/logger';
import { AiReasoningExtractor } from './ai-extractor.js';
import { HybridReasoningExtractor } from './hybrid-extractor.js';
import type { ReasoningExtractor } from './extractor-types.js';
import { mergeReasoningNodes, type PerUnitReasoningExtraction } from './merge.js';
import { buildReasoningEdges } from './edge-builder.js';
import type { ExperienceDocument } from '../semantic/types.js';
import type { ReasoningGraph } from './types.js';

export interface ReasoningExtractionOptions {
  /** When supplied, `HybridReasoningExtractor` additionally calls `@xo/ai-core`'s `extractReasoning`/`extractDecisionGraph`/`extractConstraints` per unit; when omitted, extraction is rule-based only (still a correct, if narrower, graph — see `rule-pattern-parser.ts`'s supported pattern list). */
  readonly aiCore?: AiCapabilityLayer;
  readonly domainHint?: string;
  readonly focusQuestion?: string;
  readonly logger?: Logger;
  /** Escape hatch for a caller that wants to supply its own `ReasoningExtractor` entirely (e.g. a test double), bypassing the default hybrid wiring — same convention as `../knowledge/knowledge-extractor.ts`. */
  readonly extractor?: ReasoningExtractor;
}

/**
 * Stage 7: turns Stage 3's `ExperienceDocument` into a `ReasoningGraph` —
 * the decision-making and reasoning structure the source material
 * explicitly supports (rules, prerequisites, prohibitions, policies,
 * decisions, alternatives, justifications, exceptions, escalations, risk
 * thresholds), never invented structure the source doesn't support (see
 * `rule-pattern-parser.ts`'s and `ai-extractor.ts`'s doc comments).
 *
 * Same architecture as Stage 4's `extractKnowledgeGraph` (§6's explicit
 * "follow the existing compiler extraction architecture" instruction,
 * honored structurally): runs the configured extractor over every
 * `ExperienceUnit` independently, merges candidates into deduplicated,
 * corroborated `ReasoningNode`s (`merge.ts`), then resolves every
 * candidate edge into a final `ReasoningEdge` (`edge-builder.ts`).
 *
 * Deterministic given the same `ExperienceDocument` and the same
 * extractor, for the identical reason Stage 4 is: node ids are content
 * hashes over normalized labels, never insertion order or randomness —
 * see `test/reasoning/reasoning-extractor.test.ts`'s determinism tests.
 */
export async function extractReasoningGraph(experienceDocument: ExperienceDocument, options: ReasoningExtractionOptions = {}): Promise<ReasoningGraph> {
  const extractor =
    options.extractor ??
    new HybridReasoningExtractor(options.aiCore ? new AiReasoningExtractor(options.aiCore, options.domainHint, options.focusQuestion) : undefined, options.logger);

  const perUnit: PerUnitReasoningExtraction[] = [];
  for (const unit of experienceDocument.units) {
    const result = await extractor.extract(unit);
    const extraction = result.ok ? result.value : { nodes: [], edges: [] };
    if (!result.ok) {
      options.logger?.warn('Reasoning extraction failed for a unit; it contributes no nodes', { unitId: unit.id, error: result.error.message });
    }
    perUnit.push({ unit, extraction });
  }

  const mergeResult = mergeReasoningNodes(perUnit);
  const edges = buildReasoningEdges(perUnit, mergeResult);

  return { nodes: mergeResult.nodes, edges };
}
