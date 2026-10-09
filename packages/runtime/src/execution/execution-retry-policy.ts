import { ErrorCode, RuntimeError } from '@xo/errors';
import type { ExecutionCancellation } from '../cancellation/execution-cancellation.js';

/**
 * R6. The execution-pipeline-owned retry concept — deliberately a third,
 * independent thing from:
 *   - `@xo/ai-core`'s `RetryPolicy` (per-provider-call backoff, already
 *     running *beneath* `CapabilityExecutor.execute`, invisible to this
 *     pipeline — see that class's doc comment).
 *   - `WorkflowExecutor`'s node-level `RetryPolicy` (Stage 3's
 *     workflow-graph concept; frozen, out of R6's scope entirely).
 *
 * This retry policy only ever wraps the *strategy-dispatch* step of a
 * single capability invocation — never re-planning, re-authorizing,
 * re-retrieving, or re-assembling anything upstream of it, and never
 * itself deciding *whether* a strategy is safe to retry at all (that is
 * `isRetryable`'s job below, called once per failed attempt with the
 * strategy that just ran).
 */
export interface ExecutionRetryOptions {
  /** Total attempts, including the first — `1` (the default) means "no retry", identical to every pre-R6 caller's behavior. */
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly backoffMultiplier?: number;
  /** Injected so tests don't wait out real backoff delays — defaults to identity (deterministic, no jitter), matching `@xo/ai-core`'s own `RetryPolicy` default. */
  readonly jitter?: (delayMs: number) => number;
}

export type RetryableStrategy = 'deterministic_rule' | 'model' | 'hybrid';

const DEFAULTS = { maxAttempts: 1, initialDelayMs: 50, maxDelayMs: 2000, backoffMultiplier: 2 } as const;
const identityJitter = (delayMs: number): number => delayMs;

/**
 * The only error code the pipeline ever sees from a `'model'`-strategy
 * attempt is `RUNTIME_EXECUTION_FAILED` — `CapabilityExecutor.execute`
 * wraps every provider exception into that one code (see that class).
 * That is exactly what R6 treats as retryable for `'model'`: a caught
 * provider-call failure, which XO does not manage as a side effect (see
 * this package's README's retry/idempotency notes) and which
 * `@xo/ai-core`'s own retry has already, by the time it surfaces here,
 * given up on.
 */
const MODEL_RETRYABLE_CODES: ReadonlySet<string> = new Set([ErrorCode.RUNTIME_EXECUTION_FAILED]);

export class ExecutionRetryPolicy {
  readonly maxAttempts: number;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly jitter: (delayMs: number) => number;

  constructor(options: ExecutionRetryOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.backoffMultiplier = options.backoffMultiplier ?? DEFAULTS.backoffMultiplier;
    this.jitter = options.jitter ?? identityJitter;
  }

  /**
   * Whether a failed attempt of `strategy` is safe to retry, given
   * `error`. Fails closed by default (an unrecognized code is never
   * assumed safe): only `'model'`'s one wrapped provider-failure code is
   * ever retryable.
   *
   * `'deterministic_rule'` is NEVER retryable, regardless of error code
   * — R6 cannot establish from the current `RuntimeCapabilityHandler`/
   * `CapabilityBinding` contract (`@xo/capability-contract`,
   * `capability-authority/runtime-capability-declaration.ts`) whether a
   * handler already performed a side effect before failing, so retrying
   * it risks duplicating that side effect. This is a deliberate,
   * permanent-until-a-contract-change default, not an oversight — see
   * the R6 delivery report's "Deferred" section.
   *
   * `'hybrid'` is likewise NEVER retried by this policy in this R6 pass
   * — not because whole-execution retry is unsafe in principle when
   * every step so far was `'model'` (the approved design's model), but
   * because `HybridExecutionExecutor.execute`'s failure result does not
   * currently expose which steps completed before the failure, and R6
   * chooses not to modify that R5 return shape to obtain it. See the
   * delivery report for the exact dependency being deferred rather than
   * hacked around.
   */
  isRetryable(strategy: RetryableStrategy, error: RuntimeError): boolean {
    if (strategy !== 'model') return false;
    return MODEL_RETRYABLE_CODES.has(error.code);
  }

  backoffDelayMs(attemptNumber: number): number {
    const raw = this.initialDelayMs * Math.pow(this.backoffMultiplier, attemptNumber - 1);
    return this.jitter(Math.min(raw, this.maxDelayMs));
  }
}

/**
 * Sleeps for `ms`, resolving early (with `'cancelled'`) the instant
 * `cancellation` fires — so a timeout/explicit cancel during backoff
 * terminates immediately rather than waiting out the sleep. Mirrors
 * `ExecutionPipeline.raceCancellation`'s early-resolution shape without
 * depending on it (this helper has no promise of its own to race,
 * only a timer).
 */
export function sleepRaced(ms: number, cancellation: ExecutionCancellation): Promise<'elapsed' | 'cancelled'> {
  if (cancellation.isCancelled) return Promise.resolve('cancelled');
  if (ms <= 0) return Promise.resolve('elapsed');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancellation.signal.removeEventListener('abort', onAbort);
      resolve('elapsed');
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve('cancelled');
    };
    cancellation.signal.addEventListener('abort', onAbort, { once: true });
  });
}
