import { GraphAnimationEngine } from './GraphAnimationEngine.js';
import { lerpNumber, lerpPoint, lerpViewportState } from './lerp.js';
import type { Easing } from './easing.js';
import type { EdgeId, GraphViewportState, NodeId, Point } from '../model/types.js';

const nodeKey = (id: NodeId) => `node:${id}`;
const edgeKey = (id: EdgeId) => `edge:${id}`;
const highlightKey = (id: string) => `highlight:${id}`;
const selectionKey = (id: string) => `selection:${id}`;
const executionKey = (id: NodeId) => `execution:${id}`;
const viewportKey = 'viewport';

// ---- Node animations -------------------------------------------------

/** Animates a node moving from one position to another over `durationMs`. */
export function animateNodePosition(
  engine: GraphAnimationEngine,
  nodeId: NodeId,
  from: Point,
  to: Point,
  durationMs: number,
  nowMs: number,
  easing?: Easing,
): GraphAnimationEngine {
  return engine.start(nodeKey(nodeId), from, to, durationMs, nowMs, easing);
}

/** Reads the node's current animated position, or `fallback` if it isn't animating. */
export function nodePositionAt(engine: GraphAnimationEngine, nodeId: NodeId, nowMs: number, fallback: Point): Point {
  const anim = engine.get<Point>(nodeKey(nodeId));
  return anim ? anim.valueAt(nowMs, lerpPoint) : fallback;
}

// ---- Edge animations -------------------------------------------------

/** Starts a looping "flow" animation on an edge (e.g. for a moving dash pattern along an animated/execution edge). */
export function animateEdgeFlow(engine: GraphAnimationEngine, edgeId: EdgeId, periodMs: number, nowMs: number): GraphAnimationEngine {
  return engine.start(edgeKey(edgeId), 0, 1, periodMs, nowMs, 'linear', true);
}

/** Reads the edge's flow phase in [0, 1); consumers typically map this onto a dash-offset. */
export function edgeFlowPhaseAt(engine: GraphAnimationEngine, edgeId: EdgeId, nowMs: number): number {
  const anim = engine.get<number>(edgeKey(edgeId));
  return anim ? anim.valueAt(nowMs, lerpNumber) : 0;
}

// ---- Highlight animations -------------------------------------------------

/** Starts a looping pulse (0 -> 1 -> 0) used to draw attention to a node or edge. */
export function animateHighlight(engine: GraphAnimationEngine, targetId: string, periodMs: number, nowMs: number): GraphAnimationEngine {
  return engine.start(highlightKey(targetId), 0, 1, periodMs, nowMs, 'easeInOut', true);
}

/** Reads the current pulse intensity in [0, 1] (triangle wave over the pulse period). */
export function highlightIntensityAt(engine: GraphAnimationEngine, targetId: string, nowMs: number): number {
  const anim = engine.get<number>(highlightKey(targetId));
  if (!anim) return 0;
  const p = anim.progressAt(nowMs);
  return p < 0.5 ? p * 2 : (1 - p) * 2;
}

export function stopHighlight(engine: GraphAnimationEngine, targetId: string): GraphAnimationEngine {
  return engine.stop(highlightKey(targetId));
}

// ---- Selection animations -------------------------------------------------

/** Starts a one-shot fade-in (0 -> 1) used for a selection outline/glow appearing. */
export function animateSelectionEnter(engine: GraphAnimationEngine, targetId: string, durationMs: number, nowMs: number): GraphAnimationEngine {
  return engine.start(selectionKey(targetId), 0, 1, durationMs, nowMs, 'easeOut');
}

export function selectionIntensityAt(engine: GraphAnimationEngine, targetId: string, nowMs: number): number {
  const anim = engine.get<number>(selectionKey(targetId));
  return anim ? anim.valueAt(nowMs, lerpNumber) : 1;
}

export function stopSelectionAnimation(engine: GraphAnimationEngine, targetId: string): GraphAnimationEngine {
  return engine.stop(selectionKey(targetId));
}

// ---- Execution animations -------------------------------------------------

/** Starts a looping pulse for a node currently `active` in an execution visualization. */
export function animateExecutionActive(engine: GraphAnimationEngine, nodeId: NodeId, periodMs: number, nowMs: number): GraphAnimationEngine {
  return engine.start(executionKey(nodeId), 0, 1, periodMs, nowMs, 'easeInOut', true);
}

export function executionIntensityAt(engine: GraphAnimationEngine, nodeId: NodeId, nowMs: number): number {
  const anim = engine.get<number>(executionKey(nodeId));
  if (!anim) return 0;
  const p = anim.progressAt(nowMs);
  return p < 0.5 ? p * 2 : (1 - p) * 2;
}

export function stopExecutionAnimation(engine: GraphAnimationEngine, nodeId: NodeId): GraphAnimationEngine {
  return engine.stop(executionKey(nodeId));
}

// ---- Viewport transitions -------------------------------------------------

/** Animates a smooth transition between two viewport states (pan/zoom). */
export function animateViewportTransition(
  engine: GraphAnimationEngine,
  from: GraphViewportState,
  to: GraphViewportState,
  durationMs: number,
  nowMs: number,
  easing?: Easing,
): GraphAnimationEngine {
  return engine.start(viewportKey, from, to, durationMs, nowMs, easing ?? 'easeInOut');
}

export function viewportStateAt(engine: GraphAnimationEngine, nowMs: number, fallback: GraphViewportState): GraphViewportState {
  const anim = engine.get<GraphViewportState>(viewportKey);
  return anim ? anim.valueAt(nowMs, lerpViewportState) : fallback;
}

export function isViewportTransitionComplete(engine: GraphAnimationEngine, nowMs: number): boolean {
  const anim = engine.get<GraphViewportState>(viewportKey);
  return !anim || anim.isComplete(nowMs);
}

// ---- Animated execution path -------------------------------------------------

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
export function computeExecutionPathReveal(
  path: readonly NodeId[],
  stepDurationMs: number,
  startedAtMs: number,
  nowMs: number,
): ExecutionPathReveal {
  if (path.length === 0) {
    return { revealedNodeIds: [], currentIndex: -1, progressWithinStep: 0, isComplete: true };
  }
  const elapsed = Math.max(0, nowMs - startedAtMs);
  const stepFloat = stepDurationMs <= 0 ? path.length - 1 : elapsed / stepDurationMs;
  const currentIndex = Math.min(path.length - 1, Math.floor(stepFloat));
  const progressWithinStep = currentIndex >= path.length - 1 ? 1 : stepFloat - currentIndex;
  const revealedCount = Math.min(path.length, currentIndex + 1);
  return {
    revealedNodeIds: path.slice(0, revealedCount),
    currentIndex,
    progressWithinStep,
    isComplete: currentIndex >= path.length - 1 && progressWithinStep >= 1,
  };
}
