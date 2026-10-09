/**
 * A minimal, local `Clock` port — deliberately not imported from
 * `@xo/testing` (that package is a devDependency here, for tests only;
 * production code in this package must not depend on a test-utility
 * package). `RetryPolicy`, `CircuitBreaker`, and `TokenBucketRateLimiter`
 * all take a `Clock` so their time-based behavior is exercisable
 * deterministically in tests without real `setTimeout`/`Date.now` waits —
 * see test/*.test.ts, which construct their own tiny fake clocks inline.
 */
export interface Clock {
    now(): number;
}
export declare class SystemClock implements Clock {
    now(): number;
}
//# sourceMappingURL=clock.d.ts.map