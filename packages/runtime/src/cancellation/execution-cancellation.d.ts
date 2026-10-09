/**
 * Wraps a native `AbortController` — Stage 2's one cancellation
 * primitive, threaded from `ExecutionEngine`/`ExecutionPipeline` all the
 * way down to `@xo/ai-core`'s `AiCompletionRequest.signal`. Using a
 * plain `AbortSignal` at that boundary (rather than a custom
 * cancellation type) means an `AiProvider` implementation never needs
 * to know anything about this runtime's cancellation machinery to
 * respect it — see `@xo/ai-core`'s README.
 *
 * Also implements execution *timeouts*: constructing with `timeoutMs`
 * schedules an automatic `cancel('timeout')` — timing out and being
 * explicitly cancelled share this one code path, so a caller checking
 * `reason` after the fact ('timeout' vs. anything else) is the only
 * thing that distinguishes them.
 */
export declare class ExecutionCancellation {
    private readonly controller;
    private readonly timeoutHandle;
    constructor(timeoutMs?: number);
    get signal(): AbortSignal;
    get isCancelled(): boolean;
    /** `'timeout'` if cancellation happened via the constructor's `timeoutMs`; whatever `cancel()` was called with otherwise; `undefined` if never cancelled. */
    get reason(): unknown;
    cancel(reason?: string): void;
    /** Clears the pending timeout, if any — call once an execution finishes by any means, so a completed execution's timer doesn't fire pointlessly later. */
    dispose(): void;
}
//# sourceMappingURL=execution-cancellation.d.ts.map