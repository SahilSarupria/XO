import { SystemClock } from './clock.js';
const defaultJitter = (delayMs) => delayMs; // no randomness by default — deterministic unless a caller opts into jitter
/**
 * Exponential backoff with a configurable, injectable jitter/sleep — used
 * by `router.ts` per provider attempt. `isRetryable` defaults to "retry
 * everything," matching the router's own policy of deciding
 * retryability at a higher level (an `AiError` with code
 * `AI_SCHEMA_VALIDATION_FAILED`, for instance, is worth one immediate
 * retry with a corrective note; `AI_CIRCUIT_OPEN` is not retryable at
 * all and the router never even calls into `RetryPolicy` for it).
 */
export class RetryPolicy {
    options;
    clock;
    sleep;
    jitter;
    isRetryable;
    constructor(options) {
        this.options = options;
        this.clock = options.clock ?? new SystemClock();
        this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.jitter = options.jitter ?? defaultJitter;
        this.isRetryable = options.isRetryable ?? (() => true);
    }
    async execute(fn) {
        const history = [];
        let delayMs = this.options.initialDelayMs;
        for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
            try {
                const value = await fn(attempt);
                return { value, attempts: attempt, history };
            }
            catch (error) {
                const isLastAttempt = attempt === this.options.maxAttempts;
                if (isLastAttempt || !this.isRetryable(error, attempt)) {
                    throw error;
                }
                const appliedDelay = this.jitter(Math.min(delayMs, this.options.maxDelayMs));
                history.push({ attempt, delayMs: appliedDelay, error, timestampMs: this.clock.now() });
                await this.sleep(appliedDelay);
                delayMs *= this.options.backoffMultiplier;
            }
        }
        // Unreachable: the loop above always either returns or throws before falling off the end.
        throw new Error('RetryPolicy.execute: unreachable');
    }
}
//# sourceMappingURL=retry.js.map