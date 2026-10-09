import { GraphAnimation } from './GraphAnimation.js';
import type { Easing } from './easing.js';
/**
 * Immutable registry of named, in-flight GraphAnimation instances. Every
 * mutating method returns a new engine instance — nothing here schedules
 * timers or drives itself; the host calls `start`/`stop`/`prune` as part of
 * its own render loop and reads values back out with `get`.
 */
export declare class GraphAnimationEngine {
    private readonly animations;
    constructor(animations?: ReadonlyMap<string, GraphAnimation<unknown>>);
    static empty(): GraphAnimationEngine;
    start<T>(id: string, from: T, to: T, durationMs: number, nowMs: number, easing?: Easing, loop?: boolean): GraphAnimationEngine;
    stop(id: string): GraphAnimationEngine;
    get<T = unknown>(id: string): GraphAnimation<T> | undefined;
    has(id: string): boolean;
    /** Drop non-looping animations that have finished as of `nowMs`, to keep the registry from growing unbounded. */
    prune(nowMs: number): GraphAnimationEngine;
    get activeIds(): readonly string[];
    get size(): number;
}
//# sourceMappingURL=GraphAnimationEngine.d.ts.map