import type { ProviderRequest } from '@xo/ai-core';
import type { AssembledContext } from '../context/context-assembler.js';
import type { WorkingMemoryTurn } from '../memory/working-memory.js';
export interface AssemblePromptParams {
    readonly context: AssembledContext;
    /** A concrete model identifier — `ProviderRequest.model` (`@xo/ai-core`) requires one, and model selection is `ExecutionEngine`'s job (a caller-supplied default, or the injected `ModelProvider`'s own first advertised model), not this class's. See `ExecutionEngine`'s constructor. */
    readonly model: string;
    readonly input: string;
    readonly maxOutputTokens?: number;
    /** Prior turns from `MemoryManager` for this session, oldest first — folded into `messages` ahead of the current turn. Working memory only; see `MemoryManager`'s own docs for what's explicitly out of scope. */
    readonly priorTurns?: readonly WorkingMemoryTurn[];
}
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
export declare class PromptAssembler {
    assemble(params: AssemblePromptParams): ProviderRequest;
}
//# sourceMappingURL=prompt-assembler.d.ts.map