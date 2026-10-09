import type { Point } from '../model/types.js';
export interface TouchPoint {
    readonly id: number;
    readonly point: Point;
}
export interface TouchGestureState {
    readonly touches: ReadonlyMap<number, Point>;
}
export interface PinchGesture {
    readonly kind: 'pinch';
    readonly center: Point;
    readonly scale: number;
}
export interface PanGesture {
    readonly kind: 'pan';
    readonly delta: Point;
}
export type MultiTouchGesture = PinchGesture | PanGesture;
/**
 * Deterministic multi-touch tracker: holds each active touch's last known
 * point, keyed by pointer/touch id. Purely bookkeeping — gesture
 * recognition (`gestureBetween`) is a pure function comparing two
 * snapshots, so it never depends on browser TouchEvent types.
 */
export declare class TouchGestures {
    readonly state: TouchGestureState;
    private constructor();
    static empty(): TouchGestures;
    touchStart(id: number, point: Point): TouchGestures;
    touchMove(id: number, point: Point): TouchGestures;
    touchEnd(id: number): TouchGestures;
    get activeTouchCount(): number;
    get isMultiTouch(): boolean;
    /** Pure comparison between two TouchGestures snapshots of the same touch set — the caller decides when to sample "before" and "after". */
    static gestureBetween(before: TouchGestures, after: TouchGestures): MultiTouchGesture | undefined;
}
//# sourceMappingURL=TouchGestures.d.ts.map