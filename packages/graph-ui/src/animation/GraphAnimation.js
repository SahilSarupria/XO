import { Easings } from './easing.js';
/**
 * A single deterministic animation: given `from`, `to`, a duration, and a
 * start time, `progressAt(nowMs)` / `valueAt(nowMs, lerp)` compute the
 * animation's state as a pure function of `nowMs`. There is no internal
 * timer, no `requestAnimationFrame`, and no rendering-library dependency —
 * the host application supplies `nowMs` (e.g. from its own render loop),
 * which makes every animation reproducible and unit-testable.
 */
export class GraphAnimation {
    spec;
    constructor(spec) {
        this.spec = spec;
    }
    static start(from, to, durationMs, startedAtMs, easing = 'easeInOut', loop = false) {
        return new GraphAnimation({ from, to, durationMs, startedAtMs, easing, loop });
    }
    /** Eased progress in [0, 1] (loops back to 0 forever if spec.loop is true). */
    progressAt(nowMs) {
        const elapsed = nowMs - this.spec.startedAtMs;
        const duration = Math.max(0, this.spec.durationMs);
        let raw;
        if (duration === 0) {
            raw = 1;
        }
        else if (this.spec.loop) {
            const wrapped = ((elapsed % duration) + duration) % duration;
            raw = wrapped / duration;
        }
        else {
            raw = Math.min(1, Math.max(0, elapsed / duration));
        }
        const ease = Easings[this.spec.easing ?? 'linear'];
        return ease(raw);
    }
    /** A non-looping animation is complete once nowMs passes startedAtMs + durationMs. Looping animations are never complete. */
    isComplete(nowMs) {
        if (this.spec.loop)
            return false;
        return nowMs - this.spec.startedAtMs >= this.spec.durationMs;
    }
    valueAt(nowMs, lerp) {
        return lerp(this.spec.from, this.spec.to, this.progressAt(nowMs));
    }
}
//# sourceMappingURL=GraphAnimation.js.map