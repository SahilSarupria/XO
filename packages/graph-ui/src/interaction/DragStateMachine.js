const IDLE = { phase: 'idle', targetIds: [], origin: { x: 0, y: 0 }, current: { x: 0, y: 0 } };
/**
 * Deterministic drag state machine: every transition is a pure function
 * from (state, event) -> new state. No DOM, no pointer-event types — the
 * host adapter translates its own pointer/touch events into calls on
 * `begin`/`move`/`end`/`cancel`.
 */
export class DragStateMachine {
    state;
    constructor(state) {
        this.state = state;
    }
    static idle() {
        return new DragStateMachine(IDLE);
    }
    begin(targetIds, origin, nowMs) {
        return new DragStateMachine({ phase: 'dragging', targetIds, origin, current: origin, startedAtMs: nowMs });
    }
    move(current) {
        if (this.state.phase !== 'dragging')
            return this;
        return new DragStateMachine({ ...this.state, current });
    }
    end() {
        return DragStateMachine.idle();
    }
    cancel() {
        return DragStateMachine.idle();
    }
    get isDragging() {
        return this.state.phase === 'dragging';
    }
    /** Total displacement from origin to current, in the same coordinate space both were given in. */
    get delta() {
        return { x: this.state.current.x - this.state.origin.x, y: this.state.current.y - this.state.origin.y };
    }
}
//# sourceMappingURL=DragStateMachine.js.map