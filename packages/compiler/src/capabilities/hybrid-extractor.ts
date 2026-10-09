import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { noopLogger } from '@xo/logger';
import type { KnowledgeGraph } from '../knowledge/types.js';
import type { ExperienceUnit } from '../semantic/types.js';
import type { CapabilityExtractionResult, CapabilityExtractor } from './extractor-types.js';
import { RuleBasedCapabilityExtractor } from './rule-based-extractor.js';
import { StructuredOperationCapabilityExtractor } from './structured-operation-extractor.js';

/**
 * The default extractor Stage 5 uses: `RuleBasedCapabilityExtractor` and
 * `StructuredOperationCapabilityExtractor` always run (both deterministic,
 * never fail, never call a network); an optional AI extractor runs *in
 * addition*, its candidates unioned in. If the AI call fails for a unit,
 * that unit falls back to the two structural extractors' candidates
 * alone rather than failing the whole compilation — mirrors
 * `../knowledge/hybrid-extractor.ts`'s `HybridKnowledgeExtractor`
 * exactly, for the same reason: "never fail compilation" per the Stage 5
 * brief.
 */
export class HybridCapabilityExtractor implements CapabilityExtractor {
  readonly name = 'hybrid';
  private readonly ruleBased = new RuleBasedCapabilityExtractor();
  private readonly structuredOperation = new StructuredOperationCapabilityExtractor();
  private readonly logger: Logger;

  constructor(
    private readonly aiExtractor?: CapabilityExtractor,
    logger?: Logger,
  ) {
    this.logger = logger ?? noopLogger;
  }

  async extract(unit: ExperienceUnit, knowledgeGraph: KnowledgeGraph): Promise<Result<CapabilityExtractionResult, XoError>> {
    // P0.9A area C: mirrors `../knowledge/hybrid-extractor.ts`'s identical
    // quarantine gate — a table row's cells must never become a
    // capability. `StructuredOperationCapabilityExtractor` is genuinely
    // structured-source-only (it only ever matches `type: "operation"`
    // records, never a table-derived unit), so it is not itself a risk
    // here, but gating centrally keeps this one check authoritative for
    // every current and future extractor in this union, rather than
    // relying on each one to individually decline table content.
    if (unit.isTableQuarantined) return ok({ capabilities: [], edges: [] });

    const ruleResult = await this.ruleBased.extract(unit, knowledgeGraph);
    if (!ruleResult.ok) return ruleResult; // RuleBasedCapabilityExtractor never actually returns err, but handled honestly rather than assumed away

    const structuredResult = await this.structuredOperation.extract(unit, knowledgeGraph);
    if (!structuredResult.ok) return structuredResult; // StructuredOperationCapabilityExtractor never actually returns err either — same honest handling

    // P0.9A area A: stamp each candidate with the stable `.name` of the
    // extractor that actually produced it — mirrors
    // `../knowledge/hybrid-extractor.ts`'s identical stamping.
    const ruleCaps = ruleResult.value.capabilities.map((c) => ({ ...c, extractorName: this.ruleBased.name }));
    const structuredCaps = structuredResult.value.capabilities.map((c) => ({ ...c, extractorName: this.structuredOperation.name }));

    const structural = {
      capabilities: [...ruleCaps, ...structuredCaps],
      edges: [...ruleResult.value.edges, ...structuredResult.value.edges],
    };

    if (!this.aiExtractor) {
      return ok(structural);
    }

    const aiResult = await this.aiExtractor.extract(unit, knowledgeGraph);
    if (!aiResult.ok) {
      this.logger.warn('AI capability extraction unavailable for this unit; falling back to rule-based/structured-operation only', { unitId: unit.id, error: aiResult.error.message });
      return ok(structural);
    }

    const aiCaps = aiResult.value.capabilities.map((c) => ({ ...c, extractorName: this.aiExtractor!.name }));

    return ok({
      capabilities: [...structural.capabilities, ...aiCaps],
      edges: [...structural.edges, ...aiResult.value.edges],
    });
  }
}
