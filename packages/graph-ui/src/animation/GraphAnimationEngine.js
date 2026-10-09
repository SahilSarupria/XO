import { GraphAnimation } from './GraphAnimation.js';
/**
 * Immutable registry of named, in-flight GraphAnimation instances. Every
 * mutating method returns a new engine instance — nothing here schedules
 * timers or drives itself; the host calls `start`/`stop`/`prune` as part of
 * its own render loop and reads values back out with `get`.
 */
export class GraphAnimationEngine {
    animations;
    constructor(animations = new Map()) {
        this.animations = animations;
    }
    static empty() {
        return new GraphAnimationEngine();
    }
    start(id, from, to, durationMs, nowMs, easing, loop = false) {
        const next = new Map(this.animations);
        next.set(id, GraphAnimation.start(from, to, durationMs, nowMs, easing, loop));
        return new GraphAnimationEngine(next);
    }
    stop(id) {
        if (!this.animations.has(id))
            return this;
        const next = new Map(this.animations);
        next.delete(id);
        return new GraphAnimationEngine(next);
    }
    get(id) {
        return this.animations.get(id);
    }
    has(id) {
        return this.animations.has(id);
    }
    /** Drop non-looping animations that have finished as of `nowMs`, to keep the registry from growing unbounded. */
    prune(nowMs) {
        const next = new Map([...this.animations].filter(([, anim]) => !anim.isComplete(nowMs)));
        if (next.size === this.animations.size)
            return this;
        return new GraphAnimationEngine(next);
    }
    get activeIds() {
        return [...this.animations.keys()];
    }
    get size() {
        return this.animations.size;
    }
}
//# sourceMappingURL=GraphAnimationEngine.js.map