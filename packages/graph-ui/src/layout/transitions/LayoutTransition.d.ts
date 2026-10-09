import type { GraphModel } from '../../model/GraphModel.js';
import { GraphAnimationEngine } from '../../animation/GraphAnimationEngine.js';
import type { Easing } from '../../animation/easing.js';
import type { NodeId, Point } from '../../model/types.js';
export interface LayoutTransitionResult {
    /** An animation engine seeded with a per-node position tween from the old to the new layout. */
    readonly engine: GraphAnimationEngine;
    /** The model as it looked before the transition (positions to animate FROM). */
    readonly fromModel: GraphModel;
    /** The model as it will look once the transition completes (positions to animate TO, and what to commit once done). */
    readonly toModel: GraphModel;
    readonly durationMs: number;
    readonly startedAtMs: number;
}
/**
 * Computes a layout transition between two GraphModel snapshots (typically
 * "before applyLayout" and "after applyLayout"): seeds one node-position
 * animation per node whose position actually changed, so the mental map is
 * preserved — nodes visibly glide from old to new position rather than
 * jumping. Built entirely on the existing animation primitives
 * (GraphAnimationEngine + animateNodePosition) rather than a new animation
 * mechanism.
 *
 * This never mutates a controller itself — render each frame by calling
 * `nodePositionAt`/`renderPositionsAt` below, then commit `toModel` to the
 * controller once `isLayoutTransitionComplete` is true.
 */
export declare function computeLayoutTransition(fromModel: GraphModel, toModel: GraphModel, durationMs: number, startedAtMs: number, easing?: Easing): LayoutTransitionResult;
/** The interpolated position for one node mid-transition, falling back to its final (toModel) position once the transition is done or if it wasn't animated. */
export declare function layoutTransitionPositionAt(transition: LayoutTransitionResult, nodeId: NodeId, nowMs: number): Point;
/** All node positions at `nowMs`, as a fresh GraphModel — handy for rendering a full intermediate frame without touching the controller. */
export declare function renderTransitionFrame(transition: LayoutTransitionResult, nowMs: number): GraphModel;
export declare function isLayoutTransitionComplete(transition: LayoutTransitionResult, nowMs: number): boolean;
//# sourceMappingURL=LayoutTransition.d.ts.map