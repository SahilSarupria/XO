import type { ModelProvider, ProviderRequest, ProviderResponse, ProviderStreamEvent } from '@xo/ai-core';
import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
export interface CapabilityExecutorOptions {
    readonly instrumentation?: RuntimeInstrumentation;
    readonly now?: () => Date;
}
/**
 * The **only** place `@xo/runtime` calls into `@xo/ai-core`. Talks to a
 * single injected `ModelProvider` — the vendor-neutral primitive
 * `provider-types.ts` exposes — rather than `AiCapabilityLayer`
 * (`router.ts`): that class's entire public surface is six fixed,
 * document-extraction-shaped capabilities (`extractEntities`,
 * `extractKnowledge`, ...) for the compiler's Stage 4-9 extractors, with
 * no generic "run this XO's arbitrary declared capability against
 * arbitrary input" method — a mounted package's capability isn't one of
 * those six, so `AiCapabilityLayer` has nothing to call for what Stage 2
 * actually needs. `ModelProvider` is the right integration point instead:
 * still entirely provider-agnostic (`provider-types.ts`'s own doc comment
 * confirms it's the one boundary that knows about vendors, with
 * everything above it vendor-neutral), and a plain `complete`/optional-
 * `completeStream` shape that fits Stage 2's actual need. See
 * `packages/runtime/README.md`'s "Stage 2" section for the full writeup,
 * including what this integration point does *not* get for free
 * (retry, circuit-breaking, caching, cost/cache accounting — all real,
 * all in `@xo/ai-core`, all owned by `AiCapabilityLayer`, none reachable
 * from here without going through the six extraction capabilities).
 *
 * Provider selection/config is entirely the caller's concern — this
 * class constructs nothing and selects nothing, matching "use only the
 * public interfaces of ... @xo/ai-core" and "do not duplicate logic from
 * those packages."
 */
export declare class CapabilityExecutor {
    private readonly provider;
    private readonly instrumentation;
    private readonly now;
    constructor(provider: ModelProvider, options?: CapabilityExecutorOptions);
    execute(request: ProviderRequest): Promise<Result<ProviderResponse, RuntimeError>>;
    /**
     * Streams from the provider if it implements `completeStream`;
     * otherwise falls back to a single `complete()` call emitted as one
     * `text_delta` + `done` — the exact fallback `@xo/ai-core`'s own
     * `provider-types.ts` documents for `router.ts` to use, replicated
     * here (not duplicated *logic*, just the same documented convention)
     * since bypassing `AiCapabilityLayer` means `router.ts` isn't the one
     * doing it for us.
     */
    stream(request: ProviderRequest): AsyncGenerator<ProviderStreamEvent, void, void>;
}
//# sourceMappingURL=capability-executor.d.ts.map