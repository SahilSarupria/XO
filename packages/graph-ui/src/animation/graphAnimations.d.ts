import { GraphAnimationEngine } from './GraphAnimationEngine.js';
import type { Easing } from './easing.js';
import type { EdgeId, GraphViewportState, NodeId, Point } from '../model/types.js';
/** Animates a node moving from one position to another over `durationMs`. */
export declare function animateNodePosition(engine: GraphAnimationEngine, nodeId: NodeId, from: Point, to: Point, durationMs: number, nowMs: number, easing?: Easing): GraphAnimationEngine;
/** Reads the node's current animated position, or `fallback` if it isn't animating. */
export declare function nodePositionAt(engine: GraphAnimationEngine, nodeId: NodeId, nowMs: number, fallback: Point): Point;
/** Starts a looping "flow" animation on an edge (e.g. for a moving dash pattern along an animated/execution edge). */
export declare function animateEdgeFlow(engine: GraphAnimationEngine, edgeId: EdgeId, periodMs: number, nowMs: number): GraphAnimationEngine;
/** Reads the edge's flow phase in [0, 1); consumers typically map this onto a dash-offset. */
export declare function edgeFlowPhaseAt(engine: GraphAnimationEngine, edgeId: EdgeId, nowMs: number): number;
/** Starts a looping pulse (0 -> 1 -> 0) used to draw attention to a node or edge. */
export declare function animateHighlight(engine: GraphAnimationEngine, targetId: string, periodMs: number, nowMs: number): GraphAnimationEngine;
/** Reads the current pulse intensity in [0, 1] (triangle wave over the pulse period). */
export declare function highlightIntensityAt(engine: GraphAnimationEngine, targetId: string, nowMs: number): number;
export declare function stopHighlight(engine: GraphAnimationEngine, targetId: string): GraphAnimationEngine;
/** Starts a one-shot fade-in (0 -> 1) used for a selection outline/glow appearing. */
export declare function animateSelectionEnter(engine: GraphAnimationEngine, targetId: string, durationMs: number, nowMs: number): GraphAnimationEngine;
export declare function selectionIntensityAt(engine: GraphAnimationEngine, targetId: string, nowMs: number): number;
export declare function stopSelectionAnimation(engine: GraphAnimationEngine, targetId: string): GraphAnimationEngine;
/** Starts a looping pulse for a node currently `active` in an execution visualization. */
export declare function animateExecutionActive(engine: GraphAnimationEngine, nodeId: NodeId, periodMs: number, nowMs: number): GraphAnimationEngine;
export declare function executionIntensityAt(engine: GraphAnimationEngine, nodeId: NodeId, nowMs: number): number;
export declare function stopExecutionAnimation(engine: GraphAnimationEngine, nodeId: NodeId): GraphAnimationEngine;
/** Animates a smooth transition between two viewport states (pan/zoom). */
export declare function animateViewportTransition(engine: GraphAnimationEngine, from: GraphViewportState, to: GraphViewportState, durationMs: number, nowMs: number, easing?: Easing): GraphAnimationEngine;
export declare function viewportStateAt(engine: GraphAnimationEngine, nowMs: number, fallback: GraphViewportState): GraphViewportState;
export declare function isViewportTransitionComplete(engine: GraphAnimationEngine, nowMs: number): boolean;
export interface ExecutionPathReveal {
    /** Node ids in `path` that should currently be shown as reached. */
    readonly revealedNodeIds: readonly NodeId[];
    /** Index into `path` of the node currently being "arrived at" (-1 before the animation starts). */
    readonly currentIndex: number;
    /** Progress toward revealing the next node, in [0, 1]. */
    readonly progressWithinStep: number;
    readonly isComplete: boolean;
}
/**
 * Deterministic reveal of an execution path: given the ordered node path,
 * a fixed duration per step, when the animation started, and the current
 * time, computes which prefix of the path should be shown as "reached" —
 * used to animate a runtime debugger's execution trail node by node.
 */
export declare function computeExecutionPathReveal(path: readonly NodeId[], stepDurationMs: number, startedAtMs: number, nowMs: number): ExecutionPathReveal;
//# sourceMappingURL=graphAnimations.d.ts.map