import type { Clock } from './clock.js';
export interface TokenBucketOptions {
    readonly capacity: number;
    readonly refillPerSecond: number;
    readonly clock?: Clock;
}
/**
 * A classic token bucket, one instance per provider (see `router.ts`).
 * `tryAcquire` is the non-blocking check `router.ts` uses before even
 * attempting a call (a provider at capacity is skipped in favor of the
 * next fallback candidate, rather than the caller blocking); `waitTime`
 * exposes how long a caller *would* need to wait, for a caller that wants
 * to retry after a delay instead of failing over.
 */
export declare class TokenBucketRateLimiter {
    private readonly options;
    private tokens;
    private lastRefillMs;
    private readonly clock;
    constructor(options: TokenBucketOptions);
    private refill;
    tryAcquire(cost?: number): boolean;
    /** Milliseconds until `cost` tokens will be available, given the current fill level — 0 if already available. */
    waitTimeMs(cost?: number): number;
}
//# sourceMappingURL=rate-limiter.d.ts.map