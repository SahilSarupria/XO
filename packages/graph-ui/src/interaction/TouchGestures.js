function centerOf(points) {
    const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    return { x: sum.x / points.length, y: sum.y / points.length };
}
function averageDistanceToCenter(points, center) {
    if (points.length === 0)
        return 0;
    const total = points.reduce((acc, p) => acc + Math.hypot(p.x - center.x, p.y - center.y), 0);
    return total / points.length;
}
/**
 * Deterministic multi-touch tracker: holds each active touch's last known
 * point, keyed by pointer/touch id. Purely bookkeeping — gesture
 * recognition (`gestureBetween`) is a pure function comparing two
 * snapshots, so it never depends on browser TouchEvent types.
 */
export class TouchGestures {
    state;
    constructor(state) {
        this.state = state;
    }
    static empty() {
        return new TouchGestures({ touches: new Map() });
    }
    touchStart(id, point) {
        const touches = new Map(this.state.touches);
        touches.set(id, point);
        return new TouchGestures({ touches });
    }
    touchMove(id, point) {
        if (!this.state.touches.has(id))
            return this;
        const touches = new Map(this.state.touches);
        touches.set(id, point);
        return new TouchGestures({ touches });
    }
    touchEnd(id) {
        if (!this.state.touches.has(id))
            return this;
        const touches = new Map(this.state.touches);
        touches.delete(id);
        return new TouchGestures({ touches });
    }
    get activeTouchCount() {
        return this.state.touches.size;
    }
    get isMultiTouch() {
        return this.state.touches.size >= 2;
    }
    /** Pure comparison between two TouchGestures snapshots of the same touch set — the caller decides when to sample "before" and "after". */
    static gestureBetween(before, after) {
        const beforePoints = [...before.state.touches.values()];
        const afterPoints = [...after.state.touches.values()];
        if (beforePoints.length < 2 || afterPoints.length < 2) {
            if (beforePoints.length === 1 && afterPoints.length === 1) {
                const b = beforePoints[0];
                const a = afterPoints[0];
                return { kind: 'pan', delta: { x: a.x - b.x, y: a.y - b.y } };
            }
            return undefined;
        }
        const beforeCenter = centerOf(beforePoints);
        const afterCenter = centerOf(afterPoints);
        const beforeSpread = averageDistanceToCenter(beforePoints, beforeCenter);
        const afterSpread = averageDistanceToCenter(afterPoints, afterCenter);
        const scale = beforeSpread === 0 ? 1 : afterSpread / beforeSpread;
        return { kind: 'pinch', center: afterCenter, scale };
    }
}
//# sourceMappingURL=TouchGestures.js.map