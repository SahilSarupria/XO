import type { Clock } from './clock.js';
export interface RetryPolicyOptions {
    readonly maxAttempts: number;
    readonly initialDelayMs: number;
    readonly maxDelayMs: number;
    readonly backoffMultiplier: number;
    /** Injected so backoff delay is deterministic in tests — see test/retry.test.ts, which passes a fixed sequence instead of `Math.random()`. */
    readonly jitter?: (delayMs: number) => number;
    readonly clock?: Clock;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly isRetryable?: (error: unknown, attempt: number) => boolean;
}
export interface RetryAttemptRecord {
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: unknown;
    readonly timestampMs: number;
}
export interface RetryOutcome<T> {
    readonly value: T;
    readonly attempts: number;
    readonly history: readonly RetryAttemptRecord[];
}
/**
 * Exponential backoff with a configurable, injectable jitter/sleep — used
 * by `router.ts` per provider attempt. `isRetryable` defaults to "retry
 * everything," matching the router's own policy of deciding
 * retryability at a higher level (an `AiError` with code
 * `AI_SCHEMA_VALIDATION_FAILED`, for instance, is worth one immediate
 * retry with a corrective note; `AI_CIRCUIT_OPEN` is not retryable at
 * all and the router never even calls into `RetryPolicy` for it).
 */
export declare class RetryPolicy {
    private readonly options;
    private readonly clock;
    private readonly sleep;
    private readonly jitter;
    private readonly isRetryable;
    constructor(options: RetryPolicyOptions);
    execute<T>(fn: (attempt: number) => Promise<T>): Promise<RetryOutcome<T>>;
}
//# sourceMappingURL=retry.d.ts.map