/**
 * Internal physical-motion primitive.
 *
 * Not exported from the package. Everything the camera moves —
 * position, altitude, orbit angle — moves through a critically-ish
 * damped spring rather than an eased tween. Springs never produce an
 * abrupt transition: a new target simply becomes a new resting place
 * for motion that is already underway, so movement composes cleanly
 * even when the destination changes mid-flight.
 *
 * Springs are deterministic: the same sequence of tick(dt) calls
 * against the same target always produces the same trajectory. That
 * determinism is what makes the camera testable without a real clock.
 */
export interface SpringConfig {
    /** How strongly the spring pulls toward its target. Higher = snappier. */
    stiffness?: number;
    /** How strongly motion is resisted. Higher = less overshoot. */
    damping?: number;
    /** Inertia. Higher = slower to respond. */
    mass?: number;
    /** Velocity below which the spring is considered at rest. */
    restVelocity?: number;
    /** Distance from target below which the spring is considered at rest. */
    restDelta?: number;
}
export declare class Spring {
    value: number;
    velocity: number;
    target: number;
    private readonly config;
    constructor(initial: number, config?: SpringConfig);
    /** Give the spring a new resting place without moving the value. */
    set(target: number): void;
    /** Move the value (and its target) instantly, killing velocity. Used
     * for restoring a remembered position, never for ordinary navigation. */
    jump(value: number): void;
    /** Advance the simulation by dtSeconds. Returns the new value. */
    tick(dtSeconds: number): number;
    get settled(): boolean;
}
/** A pair of springs moving together as a single point in the plane. */
export declare class Spring2D {
    readonly x: Spring;
    readonly y: Spring;
    constructor(initial: {
        x: number;
        y: number;
    }, config?: SpringConfig);
    set(target: {
        x: number;
        y: number;
    }): void;
    jump(value: {
        x: number;
        y: number;
    }): void;
    tick(dtSeconds: number): {
        x: number;
        y: number;
    };
    get settled(): boolean;
}
//# sourceMappingURL=motion.d.ts.map