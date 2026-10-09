const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
/**
 * Turns an `AssembledContext` plus the current turn's input into the
 * exact `ProviderRequest` `@xo/ai-core`'s `ModelProvider` expects — the
 * last runtime-side step before crossing into the AI Capability Layer.
 * Nothing here is provider-specific; a concrete `model` string and a
 * plain message list are all `ProviderRequest` needs. `ProviderRequest`
 * has no separate system-prompt field — `context.systemPrompt` becomes
 * the first message, with `role: 'system'`.
 *
 * `ProviderMessage`'s role vocabulary (`'system' | 'user' | 'assistant'`)
 * has no `'tool'` role and `ProviderRequest` has no `tools`/function-
 * calling field at all — `@xo/ai-core`'s `ModelProvider` layer doesn't
 * support tool calling (only `responseSchema`-driven structured output,
 * which is a request-shape concern for whoever builds a
 * `ProviderRequest`'s `responseSchema`, not something this assembler
 * currently sets). An earlier version of this package integrated against
 * a provisional stand-in `@xo/ai-core` that *did* invent tool-calling;
 * that was this package's own invention, not something the real
 * `@xo/ai-core` provides, so it's gone now that the real package is
 * wired in.
 */
export class PromptAssembler {
    assemble(params) {
        const messages = [
            { role: 'system', content: params.context.systemPrompt },
            ...(params.priorTurns ?? []).map((turn) => ({ role: turn.role, content: turn.content })),
            { role: 'user', content: params.input },
        ];
        return {
            model: params.model,
            messages,
            maxOutputTokens: params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        };
    }
}
//# sourceMappingURL=prompt-assembler.js.map