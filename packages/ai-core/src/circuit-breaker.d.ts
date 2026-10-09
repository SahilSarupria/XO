import type { Clock } from './clock.js';
export type CircuitState = 'closed' | 'open' | 'half_open';
export interface CircuitBreakerOptions {
    readonly failureThreshold: number;
    readonly cooldownMs: number;
    /** How many consecutive successes while `half_open` are required before fully closing again. */
    readonly successThreshold?: number;
    readonly clock?: Clock;
}
/**
 * A standard three-state circuit breaker, one instance per provider (see
 * `router.ts`, which keeps a `Map<ProviderId, CircuitBreaker>`). `closed`
 * lets calls through and counts consecutive failures; hitting
 * `failureThreshold` trips to `open`, which rejects every call
 * immediately (with `AI_CIRCUIT_OPEN`, never even attempting the
 * provider) until `cooldownMs` elapses; then one call is let through as a
 * `half_open` probe — success moves toward `closed` again (after
 * `successThreshold` consecutive successes), failure reopens immediately.
 */
export declare class CircuitBreaker {
    private readonly options;
    private state;
    private consecutiveFailures;
    private consecutiveSuccesses;
    private openedAtMs;
    private readonly clock;
    private readonly successThreshold;
    constructor(options: CircuitBreakerOptions);
    getState(): CircuitState;
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private onSuccess;
    private onFailure;
    private trip;
}
//# sourceMappingURL=circuit-breaker.d.ts.map