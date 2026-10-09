import type { GraphModel } from '../model/GraphModel.js';
import { GraphSelection } from '../selection/GraphSelection.js';
import type { NodeId, Point } from '../model/types.js';
export type LassoPhase = 'idle' | 'active';
export interface LassoState {
    readonly phase: LassoPhase;
    readonly points: readonly Point[];
}
/**
 * Deterministic free-form ("lasso") selection state machine: accumulates a
 * polyline of points, then selects nodes whose center falls inside the
 * closed polygon (even-odd rule).
 */
export declare class LassoSelection {
    readonly state: LassoState;
    private constructor();
    static idle(): LassoSelection;
    begin(origin: Point): LassoSelection;
    addPoint(point: Point): LassoSelection;
    end(): LassoSelection;
    get isActive(): boolean;
    matchingNodeIds(model: GraphModel): readonly NodeId[];
    toSelection(model: GraphModel): GraphSelection;
}
//# sourceMappingURL=LassoSelection.d.ts.map