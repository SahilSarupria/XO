import { AiError, ErrorCode } from '@xo/errors';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';

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
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAtMs: number | undefined;
  private readonly clock: Clock;
  private readonly successThreshold: number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.successThreshold = options.successThreshold ?? 1;
  }

  getState(): CircuitState {
    if (this.state === 'open' && this.openedAtMs !== undefined && this.clock.now() - this.openedAtMs >= this.options.cooldownMs) {
      this.state = 'half_open';
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.getState();
    if (state === 'open') {
      throw new AiError(ErrorCode.AI_CIRCUIT_OPEN, 'Circuit is open; provider calls are being rejected without attempting them');
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
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

  private onFailure(): void {
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

  private trip(): void {
    this.state = 'open';
    this.openedAtMs = this.clock.now();
    this.consecutiveFailures = 0;
  }
}
