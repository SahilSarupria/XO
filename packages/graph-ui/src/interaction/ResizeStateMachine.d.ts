import type { NodeId, Point, Size } from '../model/types.js';
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type ResizePhase = 'idle' | 'resizing';
export interface ResizeState {
    readonly phase: ResizePhase;
    readonly targetId?: NodeId;
    readonly handle?: ResizeHandle;
    readonly originSize: Size;
    readonly originPointer: Point;
    readonly currentPointer: Point;
    readonly minSize: Size;
}
/** Deterministic resize state machine, mirroring DragStateMachine's shape. */
export declare class ResizeStateMachine {
    readonly state: ResizeState;
    private constructor();
    static idle(): ResizeStateMachine;
    begin(targetId: NodeId, handle: ResizeHandle, originSize: Size, originPointer: Point, minSize?: Size): ResizeStateMachine;
    move(currentPointer: Point): ResizeStateMachine;
    end(): ResizeStateMachine;
    cancel(): ResizeStateMachine;
    get isResizing(): boolean;
    /** The resulting size given the current pointer position, respecting minSize and the active handle's axes. */
    get resultingSize(): Size;
}
//# sourceMappingURL=ResizeStateMachine.d.ts.map