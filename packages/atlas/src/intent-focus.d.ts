import type { EntityId, WorldCoordinates } from './types.js';
/**
 * Intent focus.
 *
 * "Language steers depth. It does not file a query." Atlas has no
 * opinion about language — turning a sentence into candidates is the
 * consumer's job (search, embeddings, whatever they choose). What
 * atlas provides is the *infrastructure of attention*: holding a set
 * of scored candidates, letting that attention decay if it isn't
 * reinforced, and reporting a single target to steer the camera
 * toward — the same way a few heads turning in a room resolves,
 * without anyone taking a vote, into everyone looking at one thing.
 */
export interface IntentCandidate {
    readonly id: EntityId;
    readonly position: WorldCoordinates;
    /** Relevance in [0, 1]. Values outside this range are clamped. */
    readonly score: number;
}
export interface IntentFocusOptions {
    /** Fraction of relevance lost per second when not reinforced. 0 = no decay. */
    decayPerSecond?: number;
    /** "top" steers toward the single highest-scoring candidate.
     * "weighted-centroid" steers toward the score-weighted average
     * position of all candidates, so several near-equal candidates pull
     * focus toward the space between them rather than snapping to one. */
    blend?: 'top' | 'weighted-centroid';
}
export declare class IntentFocus {
    private candidates;
    private lastUpdate;
    private readonly decayPerSecond;
    private readonly blend;
    constructor(options?: IntentFocusOptions, now?: number);
    /** Replace the current candidate set, e.g. after a new intent string
     * has been resolved by the consumer. */
    update(candidates: readonly IntentCandidate[], now?: number): void;
    /** Apply time-based decay without changing the candidate set. Safe to
     * call as often as convenient; it's a no-op if decayPerSecond is 0. */
    decay(now?: number): void;
    /** The single highest-scoring candidate, or null if attention has
     * fully decayed / nothing has been offered yet. */
    top(now?: number): IntentCandidate | null;
    /** The point atlas recommends steering the camera toward, per the
     * configured blend mode. Null when there's nothing to focus on. */
    target(now?: number): WorldCoordinates | null;
    clear(): void;
}
//# sourceMappingURL=intent-focus.d.ts.map