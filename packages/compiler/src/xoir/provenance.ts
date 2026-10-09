import { confidenceFromScore, evidenceStrengthFromCorroboration, type XoirConfidence, type XoirSourceRef } from '@xo/xoir';
import type { KnowledgeProvenance } from '../knowledge/types.js';

// Re-exported for backward compatibility: this function moved to `@xo/xoir`'s
// `confidence.ts` as of Stage 6 (see that file's doc comment for why) since
// it turned out to be generic confidence-domain infrastructure, not
// Stage 4/5-specific. Existing imports of `evidenceStrengthFromCorroboration`
// from this module keep working unchanged.
export { evidenceStrengthFromCorroboration };

/**
 * Converts Stage 4/5's `KnowledgeProvenance[]` (`../knowledge/types.ts`,
 * reused verbatim by Stage 5's `Capability.provenance`) into XOIR's
 * `XoirSourceRef[]` (`@xo/xoir`'s `node-kinds.ts`). This is a 1:1,
 * lossless field mapping — every field `KnowledgeProvenance` carries has
 * a home in `XoirSourceRef`, per the reconciliation report §16/§17's
 * "preserve source references" requirement.
 */
export function provenanceToSourceRefs(provenance: readonly KnowledgeProvenance[]): readonly XoirSourceRef[] {
  return provenance.map((p) => ({
    documentPath: p.documentPath,
    experienceUnitId: p.experienceUnitId,
    pages: p.pages,
    sectionPath: p.sectionPath,
    ...(p.charOffsetRange !== undefined ? { charOffsetRange: p.charOffsetRange } : {}),
    sourceConfidence: p.confidence,
  }));
}

/**
 * Builds a canonical {@link XoirConfidence} from a Stage 4/5 node/edge's
 * bare `confidence` number plus its own provenance list — `corroboration`
 * is the actual provenance count (real, not guessed), `basis` is
 * `'hybrid_extraction'` because both stages combine rule-based and
 * AI-assisted extraction (see `../knowledge/hybrid-extractor.ts`,
 * `../capabilities/hybrid-extractor.ts`), and `calibrated` is always
 * `false` — neither stage has ever run a calibration process, so
 * claiming otherwise would be exactly the "fabricated certainty" §9
 * warns against.
 */
export function toXoirConfidence(confidence: number, provenance: readonly KnowledgeProvenance[]): XoirConfidence {
  const corroboration = provenance.length;
  return confidenceFromScore(confidence, {
    basis: 'hybrid_extraction',
    evidenceStrength: evidenceStrengthFromCorroboration(corroboration),
    corroboration,
    calibrated: false,
  });
}
