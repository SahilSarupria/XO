import type { EdgeId, NodeId, Point } from '../model/types.js';
export type ClickTargetKind = 'node' | 'edge' | 'canvas';
export interface PointerDownEvent {
    readonly kind: ClickTargetKind;
    readonly id?: NodeId | EdgeId;
    readonly point: Point;
    readonly timestampMs: number;
}
export type ArbitratedClick = {
    readonly kind: 'click';
    readonly target: PointerDownEvent;
} | {
    readonly kind: 'doubleClick';
    readonly target: PointerDownEvent;
} | {
    readonly kind: 'longPress';
    readonly target: PointerDownEvent;
};
export interface ClickArbiterOptions {
    readonly doubleClickWindowMs?: number;
    readonly doubleClickMaxDistance?: number;
    readonly longPressThresholdMs?: number;
}
export interface PointerUpResult {
    readonly arbiter: ClickArbiter;
    readonly result: ArbitratedClick | undefined;
}
/**
 * Deterministic, immutable single/double-click and long-press arbitration.
 * There are no timers here — the host calls `pointerDown`/`pointerUp` with
 * explicit timestamps (from its own clock/render loop) and gets back both
 * the arbitration result and the next `ClickArbiter` instance to use going
 * forward, the same "returns a new instance" shape as the other state
 * machines in this module.
 */
export declare class ClickArbiter {
    private readonly state;
    private constructor();
    static create(options?: ClickArbiterOptions): ClickArbiter;
    pointerDown(event: PointerDownEvent): ClickArbiter;
    /** Resolves the click arbitrated by the down/up pair; call this on pointer up. */
    pointerUp(upPoint: Point, upTimestampMs: number): PointerUpResult;
    reset(): ClickArbiter;
}
//# sourceMappingURL=ClickArbiter.d.ts.map