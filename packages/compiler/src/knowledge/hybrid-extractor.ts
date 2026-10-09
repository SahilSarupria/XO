import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { ExperienceUnit } from '../semantic/types.js';
import type { ExtractionResult, KnowledgeExtractor } from './extractor-types.js';
import { RuleBasedKnowledgeExtractor } from './rule-based-extractor.js';

/**
 * The extractor Stage 4 actually uses by default: `RuleBasedKnowledgeExtractor`
 * always runs (it never fails, and its unit-primary node is what
 * `relationship-builder.ts` needs regardless of what else ran) — an
 * optional AI extractor runs *in addition*, and its candidates are simply
 * unioned in. If the AI call fails for a given unit (`@xo/ai-core`
 * returns an `err` Result — no provider available, rate-limited, every
 * candidate provider down, etc.), that unit falls back to the rule-based
 * candidates alone rather than failing the whole extraction: exactly the
 * compiler spec's "if AI is unavailable, the rule-based extractor should
 * still produce a correct graph with lower confidence."
 */
export class HybridKnowledgeExtractor implements KnowledgeExtractor {
  readonly name = 'hybrid';
  private readonly ruleBased = new RuleBasedKnowledgeExtractor();
  private readonly logger: Logger;

  constructor(
    private readonly aiExtractor?: KnowledgeExtractor,
    logger?: Logger,
  ) {
    this.logger = logger ?? noopLogger;
  }

  async extract(unit: ExperienceUnit): Promise<Result<ExtractionResult, XoError>> {
    // P0.9A area C (Table Detection + Quarantine): a table-quarantined
    // unit's content is cell text, not prose — running the rule-based
    // defined-term/action-process/capitalized-run heuristics (all tuned
    // for sentences) against it would silently reinterpret table data as
    // domain knowledge, exactly what quarantine exists to prevent. No
    // knowledge node is minted for it at all (not even a lower-confidence
    // one) — the unit itself, its cell content, and its full provenance
    // remain fully preserved and inspectable (`ExperienceDocument`), just
    // not fed through prose-oriented extraction.
    if (unit.isTableQuarantined) return ok({ nodes: [], edges: [] });

    const ruleResult = await this.ruleBased.extract(unit);
    if (!ruleResult.ok) return ruleResult; // RuleBasedKnowledgeExtractor never actually returns err, but the type permits it, so this is handled honestly rather than assumed away

    // P0.9A area A: stamp each candidate with the stable `.name` of the
    // extractor that actually produced it, right at the one point every
    // production candidate passes through — `merge.ts` uses this to set
    // `KnowledgeNode.producedBy` only when a merge group is unambiguous.
    const ruleNodes = ruleResult.value.nodes.map((n) => ({ ...n, extractorName: this.ruleBased.name }));

    if (!this.aiExtractor) {
      return ok({ nodes: ruleNodes, edges: ruleResult.value.edges });
    }

    const aiResult = await this.aiExtractor.extract(unit);
    if (!aiResult.ok) {
      this.logger.warn('AI knowledge extraction unavailable for this unit; falling back to rule-based only', { unitId: unit.id, error: aiResult.error.message });
      return ok({ nodes: ruleNodes, edges: ruleResult.value.edges });
    }

    const aiNodes = aiResult.value.nodes.map((n) => ({ ...n, extractorName: this.aiExtractor!.name }));

    return ok({
      nodes: [...ruleNodes, ...aiNodes],
      edges: [...ruleResult.value.edges, ...aiResult.value.edges],
    });
  }
}
