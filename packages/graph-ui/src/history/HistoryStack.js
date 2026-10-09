/**
 * Generic immutable undo/redo stack: `present` is the current value, `past`
 * holds prior values (oldest first), `future` holds values undone-away from
 * (nearest first). Every method returns a new stack — nothing is mutated
 * in place, so a HistoryStack instance is safe to hand out and compare by
 * reference.
 */
export class HistoryStack {
    past;
    present;
    future;
    constructor(past, present, future) {
        this.past = past;
        this.present = present;
        this.future = future;
    }
    static init(present) {
        return new HistoryStack([], present, []);
    }
    /** Commits a new present value, clearing redo history and capping how far back `past` goes. */
    push(value, limit = 100) {
        const past = [...this.past, this.present].slice(-limit);
        return new HistoryStack(past, value, []);
    }
    undo() {
        if (this.past.length === 0)
            return this;
        const previous = this.past[this.past.length - 1];
        const past = this.past.slice(0, -1);
        const future = [this.present, ...this.future];
        return new HistoryStack(past, previous, future);
    }
    redo() {
        if (this.future.length === 0)
            return this;
        const next = this.future[0];
        const future = this.future.slice(1);
        const past = [...this.past, this.present];
        return new HistoryStack(past, next, future);
    }
    get canUndo() {
        return this.past.length > 0;
    }
    get canRedo() {
        return this.future.length > 0;
    }
    /** Resets the stack to a single present value with empty past/future. */
    reset(present) {
        return HistoryStack.init(present);
    }
}
//# sourceMappingURL=HistoryStack.js.map