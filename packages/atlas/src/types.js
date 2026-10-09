/**
 * Shared vocabulary for the atlas engine.
 *
 * These types carry no business logic. They describe *space*, not
 * marketplaces, experiences, or products. Anything domain-specific
 * belongs to the consumer, never to atlas.
 */
export function worldCoordinates(x, y) {
    return { x, y };
}
export function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
export function lerp(from, to, t) {
    return from + (to - from) * t;
}
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
export function clamp01(value) {
    return clamp(value, 0, 1);
}
//# sourceMappingURL=types.js.map