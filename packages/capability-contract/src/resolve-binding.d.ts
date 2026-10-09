import type { BindingOutcome, BindingResolver, SemanticCapabilityContract } from './types.js';
/**
 * Runs `resolvers` in order against `contract`, returning the first
 * outcome any resolver actually produces (a resolver returning `undefined`
 * means "not applicable," and is skipped, not treated as `unresolved`).
 *
 * If every resolver is silent, the result is `unresolved` with a reason
 * naming every resolver that was tried — never silently reported as
 * "no binding," which would be indistinguishable from a caller forgetting
 * to pass any resolvers at all.
 *
 * Deliberately does not attempt any tiebreak/scoring between multiple
 * `resolved` outcomes from different resolvers — v1 ships exactly one
 * resolver (`StructuredComparisonBindingResolver`), so that case cannot
 * occur yet. A future resolver set that *can* produce competing
 * `resolved` outcomes for the same contract must decide its own
 * tiebreak policy explicitly (or return `ambiguous` itself) rather than
 * this function silently picking "first resolver wins" for a case it
 * was never designed to arbitrate.
 */
export declare function resolveCapabilityBinding(contract: SemanticCapabilityContract, resolvers: readonly BindingResolver[]): BindingOutcome;
//# sourceMappingURL=resolve-binding.d.ts.map