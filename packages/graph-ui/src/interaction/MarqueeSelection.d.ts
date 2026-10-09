import type { GraphModel } from '../model/GraphModel.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import type { NodeId, Point, Rect } from '../model/types.js';
export type MarqueePhase = 'idle' | 'active';
export interface MarqueeState {
    readonly phase: MarqueePhase;
    readonly origin: Point;
    readonly current: Point;
}
/**
 * Deterministic rectangular ("marquee") box-selection state machine. The
 * resulting rect is intersection-tested against the model with the same
 * semantics as `GraphSelection.fromBox`.
 */
export declare class MarqueeSelection {
    readonly state: MarqueeState;
    private constructor();
    static idle(): MarqueeSelection;
    begin(origin: Point): MarqueeSelection;
    update(current: Point): MarqueeSelection;
    end(): MarqueeSelection;
    get isActive(): boolean;
    get rect(): Rect;
    /** Nodes intersecting the current marquee rect, computed against `model`. */
    matchingNodeIds(model: GraphModel): readonly NodeId[];
    toSelection(model: GraphModel): GraphSelection;
}
//# sourceMappingURL=MarqueeSelection.d.ts.map