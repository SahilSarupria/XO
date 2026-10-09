import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { ExperienceUnit } from '../semantic/types.js';
import type { ReasoningExtractionResult, ReasoningExtractor } from './extractor-types.js';
import { RuleBasedReasoningExtractor } from './rule-based-extractor.js';

/**
 * The extractor Stage 7 uses by default — same posture as
 * `../knowledge/hybrid-extractor.ts`: `RuleBasedReasoningExtractor`
 * always runs and never fails; an optional AI extractor runs *in
 * addition*, and its candidates are unioned in (deduplicated/corroborated
 * by `merge.ts`, never simply concatenated as duplicates). If AI
 * extraction fails for a unit, that unit falls back to rule-based
 * candidates alone rather than failing the whole extraction — Stage 7
 * §16's "do not make AI extraction mandatory."
 */
export class HybridReasoningExtractor implements ReasoningExtractor {
  readonly name = 'hybrid';
  private readonly ruleBased = new RuleBasedReasoningExtractor();
  private readonly logger: Logger;

  constructor(
    private readonly aiExtractor?: ReasoningExtractor,
    logger?: Logger,
  ) {
    this.logger = logger ?? noopLogger;
  }

  async extract(unit: ExperienceUnit): Promise<Result<ReasoningExtractionResult, XoError>> {
    const ruleResult = await this.ruleBased.extract(unit);
    if (!ruleResult.ok) return ruleResult; // RuleBasedReasoningExtractor never actually returns err, handled honestly rather than assumed away

    if (!this.aiExtractor) return ruleResult;

    const aiResult = await this.aiExtractor.extract(unit);
    if (!aiResult.ok) {
      this.logger.warn('AI reasoning extraction unavailable for this unit; falling back to rule-based only', { unitId: unit.id, error: aiResult.error.message });
      return ruleResult;
    }

    return ok({
      nodes: [...ruleResult.value.nodes, ...aiResult.value.nodes],
      edges: [...ruleResult.value.edges, ...aiResult.value.edges],
    });
  }
}
