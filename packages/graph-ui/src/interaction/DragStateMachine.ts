import type { NodeId, Point } from '../model/types.js';

export type DragPhase = 'idle' | 'dragging';

export interface DragState {
  readonly phase: DragPhase;
  readonly targetIds: readonly NodeId[];
  readonly origin: Point;
  readonly current: Point;
  readonly startedAtMs?: number;
}

const IDLE: DragState = { phase: 'idle', targetIds: [], origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } };

/**
 * Deterministic drag state machine: every transition is a pure function
 * from (state, event) -> new state. No DOM, no pointer-event types — the
 * host adapter translates its own pointer/touch events into calls on
 * `begin`/`move`/`end`/`cancel`.
 */
export class DragStateMachine {
  private constructor(readonly state: DragState) {}

  static idle(): DragStateMachine {
    return new DragStateMachine(IDLE);
  }

  begin(targetIds: readonly NodeId[], origin: Point, nowMs: number): DragStateMachine {
    return new DragStateMachine({ phase: 'dragging', targetIds, origin, current: origin, startedAtMs: nowMs });
  }

  move(current: Point): DragStateMachine {
    if (this.state.phase !== 'dragging') return this;
    return new DragStateMachine({ ...this.state, current });
  }

  end(): DragStateMachine {
    return DragStateMachine.idle();
  }

  cancel(): DragStateMachine {
    return DragStateMachine.idle();
  }

  get isDragging(): boolean {
    return this.state.phase === 'dragging';
  }

  /** Total displacement from origin to current, in the same coordinate space both were given in. */
  get delta(): Point {
    return { x: this.state.current.x - this.state.origin.x, y: this.state.current.y - this.state.origin.y };
  }
}
