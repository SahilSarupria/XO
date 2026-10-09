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

const IDLE: ResizeState = {
  phase: 'idle',
  originSize: { width: 0, height: 0 },
  originPointer: { x: 0, y: 0 },
  currentPointer: { x: 0, y: 0 },
  minSize: { width: 1, height: 1 },
};

const HANDLE_SIGN: Readonly<Record<ResizeHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }>> = {
  n: { x: 0, y: -1 },
  s: { x: 0, y: 1 },
  e: { x: 1, y: 0 },
  w: { x: -1, y: 0 },
  ne: { x: 1, y: -1 },
  nw: { x: -1, y: -1 },
  se: { x: 1, y: 1 },
  sw: { x: -1, y: 1 },
};

/** Deterministic resize state machine, mirroring DragStateMachine's shape. */
export class ResizeStateMachine {
  private constructor(readonly state: ResizeState) {}

  static idle(): ResizeStateMachine {
    return new ResizeStateMachine(IDLE);
  }

  begin(targetId: NodeId, handle: ResizeHandle, originSize: Size, originPointer: Point, minSize: Size = { width: 1, height: 1 }): ResizeStateMachine {
    return new ResizeStateMachine({ phase: 'resizing', targetId, handle, originSize, originPointer, currentPointer: originPointer, minSize });
  }

  move(currentPointer: Point): ResizeStateMachine {
    if (this.state.phase !== 'resizing') return this;
    return new ResizeStateMachine({ ...this.state, currentPointer });
  }

  end(): ResizeStateMachine {
    return ResizeStateMachine.idle();
  }

  cancel(): ResizeStateMachine {
    return ResizeStateMachine.idle();
  }

  get isResizing(): boolean {
    return this.state.phase === 'resizing';
  }

  /** The resulting size given the current pointer position, respecting minSize and the active handle's axes. */
  get resultingSize(): Size {
    if (this.state.phase !== 'resizing' || !this.state.handle) return this.state.originSize;
    const sign = HANDLE_SIGN[this.state.handle];
    const dx = this.state.currentPointer.x - this.state.originPointer.x;
    const dy = this.state.currentPointer.y - this.state.originPointer.y;
    const width = sign.x === 0 ? this.state.originSize.width : Math.max(this.state.minSize.width, this.state.originSize.width + dx * sign.x);
    const height = sign.y === 0 ? this.state.originSize.height : Math.max(this.state.minSize.height, this.state.originSize.height + dy * sign.y);
    return { width, height };
  }
}
