/**
 * Canonical confidence model.
 *
 * A bare `number` (still `XoirNodeMetadata.confidence`/`XoirEdgeMetadata.confidence`
 * in node-kinds.ts/edge-kinds.ts, kept for backward compatibility — see below)
 * answers "how sure are we", but not "sure *how*": a 0.9 stated directly by a
 * domain expert and a 0.9 inferred from a single ambiguous sentence are not
 * the same claim, even though they'd round-trip through the same float.
 * `XoirConfidence` makes that distinction explicit instead of collapsing it.
 *
 * This is deliberately NOT a claim that scores are calibrated probabilities.
 * `calibrated` defaults to `false` everywhere in this module; only a caller
 * that has actually run a calibration process (Pareto-style back-testing
 * against known outcomes — a future compiler-level concern, not this
 * package's) should ever set it `true`.
 */
/** How a confidence value was arrived at. `'unknown'` is the honest default when an extractor/pass cannot say. */
export type ConfidenceBasis = 'stated' | 'observed' | 'inferred' | 'hybrid_extraction' | 'expert_provided' | 'unknown';
/** A coarse, human-meaningful bucket for how much evidence backs a claim — deliberately coarse rather than a second numeric score, since a fake-precise second float invites the same false-certainty problem `score` alone already has. */
export type EvidenceStrength = 'weak' | 'moderate' | 'strong' | 'unknown';
/**
 * The canonical confidence representation. `score` is the same [0,1]
 * number every caller already knows from `metadata.confidence`; the rest
 * of the fields are what make that number auditable instead of opaque.
 */
export interface XoirConfidence {
    /** 0.0–1.0. This is the value `metadata.confidence` mirrors — see {@link scoreOf}. */
    readonly score: number;
    readonly basis: ConfidenceBasis;
    readonly evidenceStrength: EvidenceStrength;
    /** Count of independent sources that corroborate this claim. 0 means single-source (or fewer). Never negative. */
    readonly corroboration: number;
    /** True only if `score` is an actually-calibrated probability (rare). Defaults to `false` — see module doc comment. */
    readonly calibrated: boolean;
}
/** The conservative default: a score is known, nothing else is claimed about it. */
export declare const UNKNOWN_CONFIDENCE_BASIS_DETAIL: Pick<XoirConfidence, 'basis' | 'evidenceStrength' | 'corroboration' | 'calibrated'>;
/**
 * Builds a full {@link XoirConfidence} from a bare numeric score, using
 * conservative ("we don't actually know") defaults for everything else.
 * This is the compatibility bridge every caller that only has a `number`
 * (most extractors, today) goes through, per §9's "if backward
 * compatibility requires retaining a simple numeric confidence accessor,
 * provide it as a compatibility view over the canonical representation."
 */
export declare function confidenceFromScore(score: number, overrides?: Partial<Omit<XoirConfidence, 'score'>>): XoirConfidence;
/** Extracts the plain numeric score from either a bare number (legacy callers) or a full {@link XoirConfidence}. */
export declare function scoreOf(confidence: XoirConfidence | number): number;
/**
 * Buckets a corroboration *count* into the coarse {@link EvidenceStrength}
 * scale — deliberately coarse (see the module doc comment): 0–1
 * independent sources is `'weak'`, 2–3 is `'moderate'`, 4+ is `'strong'`.
 * This is a real, derived signal (an actual count of corroborating
 * evidence), not a fabricated one.
 *
 * Moved here (as of Stage 6) from `@xo/compiler`'s `src/xoir/provenance.ts`,
 * which originally defined it for the Stage 4/5 adapters — it turned out
 * to be a generic confidence-domain utility with no Stage 4/5-specific
 * knowledge, and Stage 6's provenance-preserving merge (`provenance-merge.ts`)
 * needed the identical bucketing rule. `@xo/compiler`'s `provenance.ts` now
 * re-exports this instead of duplicating it — same behavior, one
 * definition. Purely additive: the function's signature and behavior are
 * unchanged from the original.
 */
export declare function evidenceStrengthFromCorroboration(corroboration: number): EvidenceStrength;
export declare function isValidConfidence(confidence: XoirConfidence): boolean;
//# sourceMappingURL=confidence.d.ts.map