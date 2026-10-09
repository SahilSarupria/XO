/**
 * A controllable clock for deterministic time-dependent tests. Any code
 * that needs `Date.now()` or `new Date()` should take a `Clock` dependency
 * instead of calling those globals directly.
 */
export interface Clock {
    now(): Date;
}
export declare class SystemClock implements Clock {
    now(): Date;
}
export declare class MockClock implements Clock {
    private current;
    constructor(initial?: Date | string);
    now(): Date;
    advance(ms: number): void;
    set(date: Date | string): void;
}
//# sourceMappingURL=mock-clock.d.ts.map