import { SystemClock } from './clock.js';
/**
 * A classic token bucket, one instance per provider (see `router.ts`).
 * `tryAcquire` is the non-blocking check `router.ts` uses before even
 * attempting a call (a provider at capacity is skipped in favor of the
 * next fallback candidate, rather than the caller blocking); `waitTime`
 * exposes how long a caller *would* need to wait, for a caller that wants
 * to retry after a delay instead of failing over.
 */
export class TokenBucketRateLimiter {
    options;
    tokens;
    lastRefillMs;
    clock;
    constructor(options) {
        this.options = options;
        this.clock = options.clock ?? new SystemClock();
        this.tokens = options.capacity;
        this.lastRefillMs = this.clock.now();
    }
    refill() {
        const now = this.clock.now();
        const elapsedSeconds = (now - this.lastRefillMs) / 1000;
        if (elapsedSeconds <= 0)
            return;
        this.tokens = Math.min(this.options.capacity, this.tokens + elapsedSeconds * this.options.refillPerSecond);
        this.lastRefillMs = now;
    }
    tryAcquire(cost = 1) {
        this.refill();
        if (this.tokens >= cost) {
            this.tokens -= cost;
            return true;
        }
        return false;
    }
    /** Milliseconds until `cost` tokens will be available, given the current fill level — 0 if already available. */
    waitTimeMs(cost = 1) {
        this.refill();
        if (this.tokens >= cost)
            return 0;
        const deficit = cost - this.tokens;
        return Math.ceil((deficit / this.options.refillPerSecond) * 1000);
    }
}
//# sourceMappingURL=rate-limiter.js.map