import type { NodeId, Point } from '../model/types.js';
export type DragPhase = 'idle' | 'dragging';
export interface DragState {
    readonly phase: DragPhase;
    readonly targetIds: readonly NodeId[];
    readonly origin: Point;
    readonly current: Point;
    readonly startedAtMs?: number;
}
/**
 * Deterministic drag state machine: every transition is a pure function
 * from (state, event) -> new state. No DOM, no pointer-event types — the
 * host adapter translates its own pointer/touch events into calls on
 * `begin`/`move`/`end`/`cancel`.
 */
export declare class DragStateMachine {
    readonly state: DragState;
    private constructor();
    static idle(): DragStateMachine;
    begin(targetIds: readonly NodeId[], origin: Point, nowMs: number): DragStateMachine;
    move(current: Point): DragStateMachine;
    end(): DragStateMachine;
    cancel(): DragStateMachine;
    get isDragging(): boolean;
    /** Total displacement from origin to current, in the same coordinate space both were given in. */
    get delta(): Point;
}
//# sourceMappingURL=DragStateMachine.d.ts.map