import type { BindingOutcome, BindingResolver, SemanticCapabilityContract } from './types.js';
/**
 * The only `BindingResolver` implemented in v1. Resolves a contract to a
 * `deterministic_rule` binding if and only if:
 *
 *   - `contract.determinism` is not explicitly `'non_deterministic'`
 *     (an explicit `'non_deterministic'` signal from the compiler is
 *     honored as a `denied` outcome — see below, not silently overridden)
 *   - `contract.rules` is non-empty (nothing to evaluate otherwise)
 *   - every rule parses as a single structured comparison via
 *     `parseComparisonCondition`, has a non-empty outcome, has no
 *     exception clause, and its condition's field phrase resolves to a
 *     runtime input key (see `resolveFieldKey`)
 *
 * Any other case returns `unresolved` with the specific reason the first
 * failing rule produced — never a partial/best-effort evaluator.
 */
export declare class StructuredComparisonBindingResolver implements BindingResolver {
    readonly name = "structured-comparison-resolver";
    resolve(contract: SemanticCapabilityContract): BindingOutcome | undefined;
}
//# sourceMappingURL=structured-comparison-resolver.d.ts.map