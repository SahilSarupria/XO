/**
 * Generic immutable undo/redo stack: `present` is the current value, `past`
 * holds prior values (oldest first), `future` holds values undone-away from
 * (nearest first). Every method returns a new stack — nothing is mutated
 * in place, so a HistoryStack instance is safe to hand out and compare by
 * reference.
 */
export declare class HistoryStack<T> {
    readonly past: readonly T[];
    readonly present: T;
    readonly future: readonly T[];
    private constructor();
    static init<T>(present: T): HistoryStack<T>;
    /** Commits a new present value, clearing redo history and capping how far back `past` goes. */
    push(value: T, limit?: number): HistoryStack<T>;
    undo(): HistoryStack<T>;
    redo(): HistoryStack<T>;
    get canUndo(): boolean;
    get canRedo(): boolean;
    /** Resets the stack to a single present value with empty past/future. */
    reset(present: T): HistoryStack<T>;
}
//# sourceMappingURL=HistoryStack.d.ts.map