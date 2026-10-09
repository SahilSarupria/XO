import { GraphAnimationEngine } from '../../animation/GraphAnimationEngine.js';
import { animateNodePosition, nodePositionAt } from '../../animation/graphAnimations.js';
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
export function computeLayoutTransition(fromModel, toModel, durationMs, startedAtMs, easing = 'easeInOut') {
    let engine = GraphAnimationEngine.empty();
    for (const toNode of toModel.nodes) {
        const fromNode = fromModel.getNode(toNode.id);
        if (!fromNode)
            continue;
        if (fromNode.position.x === toNode.position.x && fromNode.position.y === toNode.position.y)
            continue;
        engine = animateNodePosition(engine, toNode.id, fromNode.position, toNode.position, durationMs, startedAtMs, easing);
    }
    return { engine, fromModel, toModel, durationMs, startedAtMs };
}
/** The interpolated position for one node mid-transition, falling back to its final (toModel) position once the transition is done or if it wasn't animated. */
export function layoutTransitionPositionAt(transition, nodeId, nowMs) {
    const fallback = transition.toModel.getNode(nodeId)?.position ?? { x: 0, y: 0 };
    return nodePositionAt(transition.engine, nodeId, nowMs, fallback);
}
/** All node positions at `nowMs`, as a fresh GraphModel — handy for rendering a full intermediate frame without touching the controller. */
export function renderTransitionFrame(transition, nowMs) {
    let next = transition.toModel;
    for (const node of transition.toModel.nodes) {
        const position = layoutTransitionPositionAt(transition, node.id, nowMs);
        if (position.x !== node.position.x || position.y !== node.position.y) {
            next = next.upsertNode({ ...node, position });
        }
    }
    return next;
}
export function isLayoutTransitionComplete(transition, nowMs) {
    return nowMs - transition.startedAtMs >= transition.durationMs;
}
//# sourceMappingURL=LayoutTransition.js.map