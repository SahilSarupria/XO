import { lerpNumber, lerpPoint, lerpViewportState } from './lerp.js';
const nodeKey = (id) => `node:${id}`;
const edgeKey = (id) => `edge:${id}`;
const highlightKey = (id) => `highlight:${id}`;
const selectionKey = (id) => `selection:${id}`;
const executionKey = (id) => `execution:${id}`;
const viewportKey = 'viewport';
// ---- Node animations -------------------------------------------------
/** Animates a node moving from one position to another over `durationMs`. */
export function animateNodePosition(engine, nodeId, from, to, durationMs, nowMs, easing) {
    return engine.start(nodeKey(nodeId), from, to, durationMs, nowMs, easing);
}
/** Reads the node's current animated position, or `fallback` if it isn't animating. */
export function nodePositionAt(engine, nodeId, nowMs, fallback) {
    const anim = engine.get(nodeKey(nodeId));
    return anim ? anim.valueAt(nowMs, lerpPoint) : fallback;
}
// ---- Edge animations -------------------------------------------------
/** Starts a looping "flow" animation on an edge (e.g. for a moving dash pattern along an animated/execution edge). */
export function animateEdgeFlow(engine, edgeId, periodMs, nowMs) {
    return engine.start(edgeKey(edgeId), 0, 1, periodMs, nowMs, 'linear', true);
}
/** Reads the edge's flow phase in [0, 1); consumers typically map this onto a dash-offset. */
export function edgeFlowPhaseAt(engine, edgeId, nowMs) {
    const anim = engine.get(edgeKey(edgeId));
    return anim ? anim.valueAt(nowMs, lerpNumber) : 0;
}
// ---- Highlight animations -------------------------------------------------
/** Starts a looping pulse (0 -> 1 -> 0) used to draw attention to a node or edge. */
export function animateHighlight(engine, targetId, periodMs, nowMs) {
    return engine.start(highlightKey(targetId), 0, 1, periodMs, nowMs, 'easeInOut', true);
}
/** Reads the current pulse intensity in [0, 1] (triangle wave over the pulse period). */
export function highlightIntensityAt(engine, targetId, nowMs) {
    const anim = engine.get(highlightKey(targetId));
    if (!anim)
        return 0;
    const p = anim.progressAt(nowMs);
    return p < 0.5 ? p * 2 : (1 - p) * 2;
}
export function stopHighlight(engine, targetId) {
    return engine.stop(highlightKey(targetId));
}
// ---- Selection animations -------------------------------------------------
/** Starts a one-shot fade-in (0 -> 1) used for a selection outline/glow appearing. */
export function animateSelectionEnter(engine, targetId, durationMs, nowMs) {
    return engine.start(selectionKey(targetId), 0, 1, durationMs, nowMs, 'easeOut');
}
export function selectionIntensityAt(engine, targetId, nowMs) {
    const anim = engine.get(selectionKey(targetId));
    return anim ? anim.valueAt(nowMs, lerpNumber) : 1;
}
export function stopSelectionAnimation(engine, targetId) {
    return engine.stop(selectionKey(targetId));
}
// ---- Execution animations -------------------------------------------------
/** Starts a looping pulse for a node currently `active` in an execution visualization. */
export function animateExecutionActive(engine, nodeId, periodMs, nowMs) {
    return engine.start(executionKey(nodeId), 0, 1, periodMs, nowMs, 'easeInOut', true);
}
export function executionIntensityAt(engine, nodeId, nowMs) {
    const anim = engine.get(executionKey(nodeId));
    if (!anim)
        return 0;
    const p = anim.progressAt(nowMs);
    return p < 0.5 ? p * 2 : (1 - p) * 2;
}
export function stopExecutionAnimation(engine, nodeId) {
    return engine.stop(executionKey(nodeId));
}
// ---- Viewport transitions -------------------------------------------------
/** Animates a smooth transition between two viewport states (pan/zoom). */
export function animateViewportTransition(engine, from, to, durationMs, nowMs, easing) {
    return engine.start(viewportKey, from, to, durationMs, nowMs, easing ?? 'easeInOut');
}
export function viewportStateAt(engine, nowMs, fallback) {
    const anim = engine.get(viewportKey);
    return anim ? anim.valueAt(nowMs, lerpViewportState) : fallback;
}
export function isViewportTransitionComplete(engine, nowMs) {
    const anim = engine.get(viewportKey);
    return !anim || anim.isComplete(nowMs);
}
/**
 * Deterministic reveal of an execution path: given the ordered node path,
 * a fixed duration per step, when the animation started, and the current
 * time, computes which prefix of the path should be shown as "reached" —
 * used to animate a runtime debugger's execution trail node by node.
 */
export function computeExecutionPathReveal(path, stepDurationMs, startedAtMs, nowMs) {
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
//# sourceMappingURL=graphAnimations.js.map