import type { RetrievedSlice } from '../retrieval/retrieved-slice.js';
/** Mirrors `@xo/runtime-core`'s `SafetyChecker` verdict vocabulary (`'allow' | 'block' | 'redact'`) — reused directly since it's a plain string union with no packageId-shaped mismatch to work around. */
export type SafetyVerdict = 'allow' | 'block' | 'redact';
export interface SafetyCheckResult {
    readonly verdict: SafetyVerdict;
    readonly reason?: string;
    /** Present only when `verdict === 'redact'`. */
    readonly redactedInput?: string;
}
/**
 * Stage 2's deterministic safety gate — pattern matching against a
 * package's own declared `safety_rules` component, evaluated in
 * declaration order with the first matching rule winning. No AI
 * reasoning: this is a hard, auditable check that runs *before* the AI
 * Capability Layer call, not a judgment call delegated to the model
 * being invoked.
 */
export declare class SafetyPipeline {
    check(input: string, slices: readonly RetrievedSlice[]): SafetyCheckResult;
}
//# sourceMappingURL=safety-pipeline.d.ts.map