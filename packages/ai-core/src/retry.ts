import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';

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

const defaultJitter = (delayMs: number): number => delayMs; // no randomness by default — deterministic unless a caller opts into jitter

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
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: (delayMs: number) => number;
  private readonly isRetryable: (error: unknown, attempt: number) => boolean;

  constructor(private readonly options: RetryPolicyOptions) {
    this.clock = options.clock ?? new SystemClock();
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.jitter = options.jitter ?? defaultJitter;
    this.isRetryable = options.isRetryable ?? (() => true);
  }

  async execute<T>(fn: (attempt: number) => Promise<T>): Promise<RetryOutcome<T>> {
    const history: RetryAttemptRecord[] = [];
    let delayMs = this.options.initialDelayMs;

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      try {
        const value = await fn(attempt);
        return { value, attempts: attempt, history };
      } catch (error) {
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
