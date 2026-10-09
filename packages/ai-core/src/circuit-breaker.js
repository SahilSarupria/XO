import { AiError, ErrorCode } from '@xo/errors';
import { SystemClock } from './clock.js';
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
export class CircuitBreaker {
    options;
    state = 'closed';
    consecutiveFailures = 0;
    consecutiveSuccesses = 0;
    openedAtMs;
    clock;
    successThreshold;
    constructor(options) {
        this.options = options;
        this.clock = options.clock ?? new SystemClock();
        this.successThreshold = options.successThreshold ?? 1;
    }
    getState() {
        if (this.state === 'open' && this.openedAtMs !== undefined && this.clock.now() - this.openedAtMs >= this.options.cooldownMs) {
            this.state = 'half_open';
        }
        return this.state;
    }
    async execute(fn) {
        const state = this.getState();
        if (state === 'open') {
            throw new AiError(ErrorCode.AI_CIRCUIT_OPEN, 'Circuit is open; provider calls are being rejected without attempting them');
        }
        try {
            const result = await fn();
            this.onSuccess();
            return result;
        }
        catch (error) {
            this.onFailure();
            throw error;
        }
    }
    onSuccess() {
        this.consecutiveFailures = 0;
        if (this.state === 'half_open') {
            this.consecutiveSuccesses += 1;
            if (this.consecutiveSuccesses >= this.successThreshold) {
                this.state = 'closed';
                this.consecutiveSuccesses = 0;
                this.openedAtMs = undefined;
            }
        }
    }
    onFailure() {
        this.consecutiveSuccesses = 0;
        if (this.state === 'half_open') {
            this.trip();
            return;
        }
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.options.failureThreshold) {
            this.trip();
        }
    }
    trip() {
        this.state = 'open';
        this.openedAtMs = this.clock.now();
        this.consecutiveFailures = 0;
    }
}
//# sourceMappingURL=circuit-breaker.js.map