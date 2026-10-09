import { type IntentFocusOptions, type WorldCoordinates } from '@xo/atlas';
import type { MarketplaceWorld, XOId } from './types.js';
/**
 * A resolved candidate the consumer has already determined is
 * relevant to some intent \u2014 this package never resolves language
 * itself (requirement 7 explicitly forbids an LLM/search engine
 * here). The consumer does that resolution however it likes and
 * hands the result in as (xoId, score) pairs.
 */
export interface ResolvedCandidate {
    readonly xoId: XOId;
    readonly score: number;
}
/**
 * Feeds resolved candidates through Atlas's IntentFocus and exposes
 * the resulting camera target in marketplace terms.
 */
export declare class MarketplaceIntent {
    private readonly world;
    private readonly focus;
    constructor(world: MarketplaceWorld, options?: IntentFocusOptions);
    /** Register a fresh set of resolved candidates, e.g. after the
     * consumer resolves a new natural-language intent string. Candidates
     * for XOs with no known position are silently dropped. */
    update(candidates: readonly ResolvedCandidate[], now?: number): void;
    /** The single most relevant XO right now, or null. */
    topXOId(now?: number): XOId | null;
    /** Where the camera should be steered to reflect current intent. */
    target(now?: number): WorldCoordinates | null;
    clear(): void;
}
//# sourceMappingURL=intent.d.ts.map