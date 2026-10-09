/**
 * The depth model.
 *
 * Altitude is the single axis of "how close." Zero navigation happens
 * on this axis — only motion toward or away from more detail. Atlas
 * does not hardcode what the levels mean. A marketplace might use
 * Ecosystem → Community → Experience → Capability → Workflow →
 * Reasoning → Memory → Execution. A debugger might use five levels
 * that mean something else entirely. The engine only needs to know
 * that levels exist, that they're ordered, and where their edges are.
 */
export interface AltitudeLevel {
    /** Stable identifier, e.g. "experience" or "execution". */
    readonly id: string;
    /** Position in the depth order. Lower is shallower (further away). */
    readonly order: number;
    /** Human-readable name for this level. */
    readonly label: string;
    /** Optional description of what becomes visible at this level. */
    readonly description?: string;
}
export declare class AltitudeModel {
    private readonly levels;
    constructor(levels: readonly AltitudeLevel[]);
    /** The shallowest defined altitude. */
    get min(): number;
    /** The deepest defined altitude. */
    get max(): number;
    /** All levels, shallow to deep. */
    all(): readonly AltitudeLevel[];
    byId(id: string): AltitudeLevel | undefined;
    byOrder(order: number): AltitudeLevel | undefined;
    /** Constrain a continuous altitude value to the defined range. */
    clamp(order: number): number;
    /** The nearest defined level to a continuous altitude value. */
    nearest(order: number): AltitudeLevel;
    /** The next level deeper than the given altitude, if any. */
    deeper(order: number): AltitudeLevel | undefined;
    /** The next level shallower than the given altitude, if any. */
    shallower(order: number): AltitudeLevel | undefined;
}
//# sourceMappingURL=altitude.d.ts.map