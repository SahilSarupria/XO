import { err, ok } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
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
export class CapabilityExecutor {
    provider;
    instrumentation;
    now;
    constructor(provider, options = {}) {
        this.provider = provider;
        this.instrumentation = options.instrumentation;
        this.now = options.now ?? (() => new Date());
    }
    async execute(request) {
        const startedAt = this.now().getTime();
        try {
            const response = await this.provider.complete(request);
            const durationMs = this.now().getTime() - startedAt;
            this.instrumentation?.recordAiCallLatency(durationMs, { provider: this.provider.id, finishReason: response.finishReason });
            this.instrumentation?.recordTokenUsage({ promptTokens: response.usage.inputTokens, completionTokens: response.usage.outputTokens }, { provider: this.provider.id });
            return ok(response);
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : 'unknown AI provider error';
            return err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `AI Capability Layer call failed: ${message}`, { cause }));
        }
    }
    /**
     * Streams from the provider if it implements `completeStream`;
     * otherwise falls back to a single `complete()` call emitted as one
     * `text_delta` + `done` — the exact fallback `@xo/ai-core`'s own
     * `provider-types.ts` documents for `router.ts` to use, replicated
     * here (not duplicated *logic*, just the same documented convention)
     * since bypassing `AiCapabilityLayer` means `router.ts` isn't the one
     * doing it for us.
     */
    async *stream(request) {
        if (this.provider.completeStream) {
            yield* this.provider.completeStream(request);
            return;
        }
        const response = await this.provider.complete(request);
        yield { type: 'text_delta', delta: response.text };
        yield { type: 'done', usage: response.usage, finishReason: response.finishReason };
    }
}
//# sourceMappingURL=capability-executor.js.map