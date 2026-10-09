import { IntentFocus } from '@xo/atlas';
/**
 * Feeds resolved candidates through Atlas's IntentFocus and exposes
 * the resulting camera target in marketplace terms.
 */
export class MarketplaceIntent {
    world;
    focus;
    constructor(world, options = {}) {
        this.world = world;
        this.focus = new IntentFocus(options);
    }
    /** Register a fresh set of resolved candidates, e.g. after the
     * consumer resolves a new natural-language intent string. Candidates
     * for XOs with no known position are silently dropped. */
    update(candidates, now) {
        const withPositions = candidates
            .map((c) => {
            const position = this.world.positions.get(c.xoId);
            return position ? { id: c.xoId, position, score: c.score } : null;
        })
            .filter((c) => c !== null);
        this.focus.update(withPositions, now);
    }
    /** The single most relevant XO right now, or null. */
    topXOId(now) {
        return this.focus.top(now)?.id ?? null;
    }
    /** Where the camera should be steered to reflect current intent. */
    target(now) {
        return this.focus.target(now);
    }
    clear() {
        this.focus.clear();
    }
}
//# sourceMappingURL=intent.js.map