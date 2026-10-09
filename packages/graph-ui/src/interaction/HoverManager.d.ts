import type { EdgeId, NodeId } from '../model/types.js';
export type HoverTargetKind = 'node' | 'edge' | 'none';
export interface HoverState {
    readonly kind: HoverTargetKind;
    readonly id?: NodeId | EdgeId;
    readonly enteredAtMs?: number;
}
/** Deterministic single-target hover tracker (one thing hovered at a time, like a real pointer). */
export declare class HoverManager {
    readonly state: HoverState;
    private constructor();
    static none(): HoverManager;
    hoverNode(id: NodeId, nowMs: number): HoverManager;
    hoverEdge(id: EdgeId, nowMs: number): HoverManager;
    clear(): HoverManager;
    get hoverDurationMs(): (nowMs: number) => number;
}
//# sourceMappingURL=HoverManager.d.ts.map