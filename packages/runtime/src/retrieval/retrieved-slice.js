/**
 * A rough, deterministic token estimate — Stage 2 has no tokenizer
 * dependency, so this is intentionally a simple, documented
 * approximation (4 characters per token, the same rule of thumb `@xo/package-sdk`'s
 * own docs and most providers' public guidance use), not a precise
 * count. Real per-provider tokenization belongs to a real `@xo/ai-core`
 * implementation, which returns an authoritative `AiUsage` after a real
 * call; this estimate is only ever used pre-call, for budgeting.
 */
export function estimateTokens(content) {
    return Math.ceil(content.length / 4);
}
//# sourceMappingURL=retrieved-slice.js.map