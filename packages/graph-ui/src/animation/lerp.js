export function lerpNumber(a, b, t) {
    return a + (b - a) * t;
}
export function lerpPoint(a, b, t) {
    return { x: lerpNumber(a.x, b.x, t), y: lerpNumber(a.y, b.y, t) };
}
export function lerpViewportState(a, b, t) {
    return { x: lerpNumber(a.x, b.x, t), y: lerpNumber(a.y, b.y, t), zoom: lerpNumber(a.zoom, b.zoom, t) };
}
//# sourceMappingURL=lerp.js.map