/**
 * Semantic zoom.
 *
 * Map zoom makes things bigger. Semantic zoom makes things *more
 * true* — new meaning is revealed at depth, not a magnified version
 * of what was already visible. A rule declares the altitude range
 * across which something goes from absent to fully present. Between
 * those two points, atlas reports a continuous visibility value so a
 * consumer can fade it in rather than pop it in.
 *
 * The registry holds no opinion about what "something" is — `data`
 * is opaque to atlas. This is infrastructure for emergence, not a
 * content model.
 */
export interface SemanticZoomRule<T = unknown> {
    readonly id: string;
    /** Altitude at which this begins to appear (visibility 0). */
    readonly appearsAt: number;
    /** Altitude at which this is fully present (visibility 1). */
    readonly fullyVisibleAt: number;
    readonly data?: T;
}
export interface EmergenceState<T = unknown> {
    readonly id: string;
    /** 0 = not yet emerged, 1 = fully present. Never negative or above 1. */
    readonly visibility: number;
    readonly data?: T;
}
export declare class SemanticZoomRegistry<T = unknown> {
    private readonly rules;
    register(rule: SemanticZoomRule<T>): void;
    unregister(id: string): void;
    clear(): void;
    /** Every registered rule's emergence state at a given altitude. */
    at(altitude: number): EmergenceState<T>[];
    /** Only what has begun to emerge (visibility > 0), most visible first. */
    visible(altitude: number): EmergenceState<T>[];
}
//# sourceMappingURL=semantic-zoom.d.ts.map