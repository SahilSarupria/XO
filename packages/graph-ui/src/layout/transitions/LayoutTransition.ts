import type { GraphModel } from '../../model/GraphModel.js';
import { GraphAnimationEngine } from '../../animation/GraphAnimationEngine.js';
import { animateNodePosition, nodePositionAt } from '../../animation/graphAnimations.js';
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
export function computeLayoutTransition(
  fromModel: GraphModel,
  toModel: GraphModel,
  durationMs: number,
  startedAtMs: number,
  easing: Easing = 'easeInOut',
): LayoutTransitionResult {
  let engine = GraphAnimationEngine.empty();
  for (const toNode of toModel.nodes) {
    const fromNode = fromModel.getNode(toNode.id);
    if (!fromNode) continue;
    if (fromNode.position.x === toNode.position.x && fromNode.position.y === toNode.position.y) continue;
    engine = animateNodePosition(engine, toNode.id, fromNode.position, toNode.position, durationMs, startedAtMs, easing);
  }
  return { engine, fromModel, toModel, durationMs, startedAtMs };
}

/** The interpolated position for one node mid-transition, falling back to its final (toModel) position once the transition is done or if it wasn't animated. */
export function layoutTransitionPositionAt(transition: LayoutTransitionResult, nodeId: NodeId, nowMs: number): Point {
  const fallback = transition.toModel.getNode(nodeId)?.position ?? { x: 0, y: 0 };
  return nodePositionAt(transition.engine, nodeId, nowMs, fallback);
}

/** All node positions at `nowMs`, as a fresh GraphModel — handy for rendering a full intermediate frame without touching the controller. */
export function renderTransitionFrame(transition: LayoutTransitionResult, nowMs: number): GraphModel {
  let next = transition.toModel;
  for (const node of transition.toModel.nodes) {
    const position = layoutTransitionPositionAt(transition, node.id, nowMs);
    if (position.x !== node.position.x || position.y !== node.position.y) {
      next = next.upsertNode({ ...node, position });
    }
  }
  return next;
}

export function isLayoutTransitionComplete(transition: LayoutTransitionResult, nowMs: number): boolean {
  return nowMs - transition.startedAtMs >= transition.durationMs;
}
