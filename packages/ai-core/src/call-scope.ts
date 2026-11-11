import { AiError, ErrorCode } from '@xo/errors';

/**
 * Per-capability-call cancellation scope: one total deadline plus the caller's own `AbortSignal`, covering every retry and
 * fallback candidate of ONE `AiCapabilityLayer` call.
 *
 * Contract (see `docs/inference-cache-and-policy.md`, Slice 8):
 * - `signal` aborts when the deadline expires OR the caller aborts, whichever is first; `cancellation()` says which.
 * - The router stops WAITING at that moment even if a provider ignores `signal` (`race`); a provider that honours it also
 *   stops its HTTP work and backoff.
 * - Whatever a provider returns after cancellation is a LATE outcome: it is handed to the `onLate` callback (so billing can
 *   still be reconciled) and is never returned to the caller or cached.
 * - `commit()` marks the point where a validated answer has been accepted: the timer is stopped and cancellation no longer
 *   applies, so a deadline can never flip an already-accepted answer into a failure while it is being cached.
 */
export type CallCancellationReason = 'deadline' | 'caller_abort';

export interface CallCancellation {
  readonly reason: CallCancellationReason;
  readonly deadlineMs?: number;
}

export type LateOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** Thrown inside an attempt when the call is cancelled. Never counts against a circuit breaker; never retried. */
export class CallCancelledError extends Error {
  constructor(readonly cancellation: CallCancellation) {
    super(cancellation.reason === 'deadline' ? 'AI call total deadline exceeded' : 'AI call cancelled by caller');
    this.name = 'CallCancelledError';
  }
}

export function isCallCancelled(error: unknown): error is CallCancelledError {
  return error instanceof CallCancelledError;
}

/** Context key carried on the final `AiError` so callers can tell a deadline/cancel from an ordinary provider failure. */
const CANCELLATION_CONTEXT_KEY = 'callCancellation';

export function callCancellationError(
  cancellation: CallCancellation,
  details: { readonly attempts: number; readonly failureCount: number },
): AiError {
  const message =
    cancellation.reason === 'deadline'
      ? `AI call exceeded its total deadline of ${cancellation.deadlineMs ?? '?'}ms (covering retries and fallback); any late provider response is discarded`
      : 'AI call was cancelled by the caller; any late provider response is discarded';
  return new AiError(ErrorCode.AI_ALL_PROVIDERS_FAILED, message, {
    context: {
      [CANCELLATION_CONTEXT_KEY]: cancellation.reason,
      ...(cancellation.deadlineMs !== undefined ? { deadlineMs: cancellation.deadlineMs } : {}),
      ...details,
    },
  });
}

/** Returns the cancellation an `AiError` from the router carries, if it was a deadline/cancel outcome. */
export function getCallCancellation(error: unknown): CallCancellation | undefined {
  if (!(error instanceof AiError)) return undefined;
  const ctx = error.context as Record<string, unknown>;
  const reason = ctx[CANCELLATION_CONTEXT_KEY];
  if (reason !== 'deadline' && reason !== 'caller_abort') return undefined;
  return { reason, ...(typeof ctx['deadlineMs'] === 'number' ? { deadlineMs: ctx['deadlineMs'] } : {}) };
}

export interface CallScopeOptions {
  /** Total wall-clock budget for the whole call (retries + fallback + backoff). Absent = no deadline. */
  readonly deadlineMs?: number;
  readonly callerSignal?: AbortSignal;
}

export class CallScope {
  private readonly controller = new AbortController();
  private reasonValue: CallCancellationReason | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private committed = false;
  private readonly onCallerAbort = (): void => this.cancel('caller_abort');

  constructor(private readonly options: CallScopeOptions) {
    if (options.callerSignal?.aborted) {
      this.cancel('caller_abort');
    } else {
      options.callerSignal?.addEventListener('abort', this.onCallerAbort, { once: true });
      if (options.deadlineMs !== undefined) this.timer = setTimeout(() => this.cancel('deadline'), options.deadlineMs);
    }
  }

  /** Whether anything can abort this scope (so the router only hands providers a signal when one is meaningful). */
  get active(): boolean {
    return this.options.deadlineMs !== undefined || this.options.callerSignal !== undefined;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** The first cancellation cause, once cancelled (and not yet committed). */
  cancellation(): CallCancellation | undefined {
    if (this.reasonValue === undefined) return undefined;
    return { reason: this.reasonValue, ...(this.options.deadlineMs !== undefined ? { deadlineMs: this.options.deadlineMs } : {}) };
  }

  throwIfCancelled(): void {
    const c = this.cancellation();
    if (c) throw new CallCancelledError(c);
  }

  /** The validated answer is accepted: stop the timer and ignore any later cancellation. */
  commit(): void {
    this.committed = true;
    this.clear();
  }

  /** Always call (in `finally`): releases the timer and the listener on the caller's signal. */
  dispose(): void {
    this.clear();
  }

  /**
   * Resolves/rejects like `promise`, unless the scope is cancelled first, in which case it rejects with `CallCancelledError`
   * at once and `onLate` receives the promise's eventual outcome. `onLate` must not throw (it is guarded anyway).
   */
  race<T>(promise: Promise<T>, onLate: (outcome: LateOutcome<T>) => void): Promise<T> {
    const late = (outcome: LateOutcome<T>): void => {
      try {
        onLate(outcome);
      } catch {
        /* a late-outcome handler must never surface as an unhandled rejection */
      }
    };
    const cancelled = this.cancellation();
    if (cancelled) {
      promise.then(
        (value) => late({ ok: true, value }),
        (error: unknown) => late({ ok: false, error }),
      );
      return Promise.reject(new CallCancelledError(cancelled));
    }
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const onAbort = (): void => {
        if (done) return;
        done = true;
        reject(new CallCancelledError(this.cancellation() ?? { reason: 'caller_abort' }));
      };
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          this.controller.signal.removeEventListener('abort', onAbort);
          if (done) return late({ ok: true, value });
          done = true;
          resolve(value);
        },
        (error: unknown) => {
          this.controller.signal.removeEventListener('abort', onAbort);
          if (done) return late({ ok: false, error });
          done = true;
          reject(error);
        },
      );
    });
  }

  /** A backoff sleep that ends (rejecting with `CallCancelledError`) the moment the scope is cancelled. */
  async sleep(ms: number, injected?: (ms: number) => Promise<void>): Promise<void> {
    this.throwIfCancelled();
    if (injected) {
      await this.race(injected(ms), () => {});
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await this.race(wait, () => {});
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private cancel(reason: CallCancellationReason): void {
    if (this.committed || this.reasonValue !== undefined) return;
    this.reasonValue = reason;
    this.clear();
    this.controller.abort();
  }

  private clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.options.callerSignal?.removeEventListener('abort', this.onCallerAbort);
  }
}
