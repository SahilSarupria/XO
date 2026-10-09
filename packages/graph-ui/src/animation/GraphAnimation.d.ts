import { type Easing } from './easing.js';
export interface AnimationSpec<T> {
    readonly from: T;
    readonly to: T;
    readonly durationMs: number;
    /** Absolute time (in the same clock the caller passes to progressAt/valueAt) the animation began. */
    readonly startedAtMs: number;
    readonly easing?: Easing;
    /** If true, the animation repeats indefinitely: progress wraps every durationMs instead of clamping at 1. */
    readonly loop?: boolean;
}
/**
 * A single deterministic animation: given `from`, `to`, a duration, and a
 * start time, `progressAt(nowMs)` / `valueAt(nowMs, lerp)` compute the
 * animation's state as a pure function of `nowMs`. There is no internal
 * timer, no `requestAnimationFrame`, and no rendering-library dependency —
 * the host application supplies `nowMs` (e.g. from its own render loop),
 * which makes every animation reproducible and unit-testable.
 */
export declare class GraphAnimation<T> {
    readonly spec: AnimationSpec<T>;
    constructor(spec: AnimationSpec<T>);
    static start<T>(from: T, to: T, durationMs: number, startedAtMs: number, easing?: Easing, loop?: boolean): GraphAnimation<T>;
    /** Eased progress in [0, 1] (loops back to 0 forever if spec.loop is true). */
    progressAt(nowMs: number): number;
    /** A non-looping animation is complete once nowMs passes startedAtMs + durationMs. Looping animations are never complete. */
    isComplete(nowMs: number): boolean;
    valueAt(nowMs: number, lerp: (a: T, b: T, t: number) => T): T;
}
//# sourceMappingURL=GraphAnimation.d.ts.map