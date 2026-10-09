/**
 * Generic immutable undo/redo stack: `present` is the current value, `past`
 * holds prior values (oldest first), `future` holds values undone-away from
 * (nearest first). Every method returns a new stack — nothing is mutated
 * in place, so a HistoryStack instance is safe to hand out and compare by
 * reference.
 */
export class HistoryStack<T> {
  private constructor(
    readonly past: readonly T[],
    readonly present: T,
    readonly future: readonly T[],
  ) {}

  static init<T>(present: T): HistoryStack<T> {
    return new HistoryStack<T>([], present, []);
  }

  /** Commits a new present value, clearing redo history and capping how far back `past` goes. */
  push(value: T, limit = 100): HistoryStack<T> {
    const past = [...this.past, this.present].slice(-limit);
    return new HistoryStack<T>(past, value, []);
  }

  undo(): HistoryStack<T> {
    if (this.past.length === 0) return this;
    const previous = this.past[this.past.length - 1] as T;
    const past = this.past.slice(0, -1);
    const future = [this.present, ...this.future];
    return new HistoryStack<T>(past, previous, future);
  }

  redo(): HistoryStack<T> {
    if (this.future.length === 0) return this;
    const next = this.future[0] as T;
    const future = this.future.slice(1);
    const past = [...this.past, this.present];
    return new HistoryStack<T>(past, next, future);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Resets the stack to a single present value with empty past/future. */
  reset(present: T): HistoryStack<T> {
    return HistoryStack.init(present);
  }
}
