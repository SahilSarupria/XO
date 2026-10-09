/**
 * The provider abstraction — the ONE boundary in this package that knows
 * anything about "OpenAI" vs "Anthropic" vs "Gemini" vs "Ollama" vs
 * "Azure OpenAI". Everything above `ModelProvider` (capabilities.ts,
 * router.ts) talks only in these vendor-neutral request/response shapes;
 * everything below it (providers/*.ts) is one file per vendor translating
 * this shape into that vendor's actual HTTP contract. A caller of
 * `AiCapabilityLayer` never sees any of this directly — see
 * capability-types.ts for the layer callers actually interact with.
 */
export {};
//# sourceMappingURL=provider-types.js.map