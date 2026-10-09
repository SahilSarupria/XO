import { clamp01 } from './types.js';
export class IntentFocus {
    candidates = new Map();
    lastUpdate;
    decayPerSecond;
    blend;
    constructor(options = {}, now = Date.now()) {
        this.decayPerSecond = options.decayPerSecond ?? 0;
        this.blend = options.blend ?? 'top';
        this.lastUpdate = now;
    }
    /** Replace the current candidate set, e.g. after a new intent string
     * has been resolved by the consumer. */
    update(candidates, now = Date.now()) {
        this.decay(now);
        this.candidates = new Map(candidates.map((c) => [c.id, { id: c.id, position: c.position, score: clamp01(c.score) }]));
        this.lastUpdate = now;
    }
    /** Apply time-based decay without changing the candidate set. Safe to
     * call as often as convenient; it's a no-op if decayPerSecond is 0. */
    decay(now = Date.now()) {
        if (this.decayPerSecond <= 0)
            return;
        const seconds = Math.max(0, (now - this.lastUpdate) / 1000);
        if (seconds <= 0)
            return;
        const factor = clamp01(1 - this.decayPerSecond * seconds);
        for (const candidate of this.candidates.values())
            candidate.score *= factor;
        this.lastUpdate = now;
    }
    /** The single highest-scoring candidate, or null if attention has
     * fully decayed / nothing has been offered yet. */
    top(now = Date.now()) {
        this.decay(now);
        let best = null;
        for (const candidate of this.candidates.values()) {
            if (candidate.score <= 0)
                continue;
            if (!best || candidate.score > best.score)
                best = candidate;
        }
        return best ? { id: best.id, position: best.position, score: best.score } : null;
    }
    /** The point atlas recommends steering the camera toward, per the
     * configured blend mode. Null when there's nothing to focus on. */
    target(now = Date.now()) {
        this.decay(now);
        const live = [...this.candidates.values()].filter((c) => c.score > 0);
        if (live.length === 0)
            return null;
        if (this.blend === 'top') {
            const best = live.reduce((a, b) => (b.score > a.score ? b : a));
            return best.position;
        }
        let totalWeight = 0;
        let x = 0;
        let y = 0;
        for (const candidate of live) {
            x += candidate.position.x * candidate.score;
            y += candidate.position.y * candidate.score;
            totalWeight += candidate.score;
        }
        return totalWeight > 0 ? { x: x / totalWeight, y: y / totalWeight } : null;
    }
    clear() {
        this.candidates.clear();
    }
}
//# sourceMappingURL=intent-focus.js.map