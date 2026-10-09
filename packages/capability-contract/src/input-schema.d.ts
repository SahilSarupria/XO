import type { CapabilityInputSchema } from '@xo/types';
/**
 * One structural problem with a candidate input, relative to a
 * `CapabilityInputSchema`. Deliberately small and flat (this schema type
 * has no nesting to report a path through) — see
 * `CapabilityInputSchema`'s doc comment in `@xo/types` for why this
 * validator doesn't need `@xo/ai-core`'s more general `validateJsonSchema`.
 */
export interface CapabilityInputValidationIssue {
    readonly property: string;
    readonly message: string;
}
export type CapabilityInputValidationResult = {
    readonly valid: true;
} | {
    readonly valid: false;
    readonly issues: readonly CapabilityInputValidationIssue[];
};
/**
 * R2's validation boundary: capability → execution declaration → input
 * schema → validate input → execute. Called with the schema from a
 * resolved `CapabilityExecutionDeclaration.inputSchema` (R1) BEFORE any
 * deterministic binding is evaluated, so a malformed input never reaches
 * `StructuredComparisonBindingResolver`'s evaluator — that evaluator has
 * no obligation to validate its own input shape defensively because this
 * function is the contract's enforcement point, not it.
 *
 * A required property that is `null` is rejected (`null` is not, e.g., a
 * `number`) — this validator does not treat "present but null" as
 * satisfying a required, typed property. An unknown property (present in
 * `input` but not declared in `schema.properties`) is rejected too: an
 * `inputSchema` is meant to describe the complete accepted shape for a
 * deterministic rule, not a minimum floor, so silently accepting
 * additional fields would let a caller pass data the schema's author
 * never reviewed.
 */
export declare function validateCapabilityInput(schema: CapabilityInputSchema, input: unknown): CapabilityInputValidationResult;
//# sourceMappingURL=input-schema.d.ts.map