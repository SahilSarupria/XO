/**
 * Phase 2 — Structured Semantic Expressions.
 *
 * This module is the generalization of `comparison-grammar.ts`'s closed,
 * deterministic, single-numeric-comparison grammar into the fuller set of
 * condition/action shapes XOIR reasoning nodes actually contain: numeric
 * comparisons, threshold/range conditions, categorical/boolean state
 * conditions, conjunctions, disjunctions, and a deliberately narrow,
 * non-inferential subset of temporal relations. It also parses a rule's
 * *action* side (e.g. `"deny the claim"`) into a `{action, target}` shape.
 *
 * `comparison-grammar.ts` and `structured-comparison-resolver.ts` are left
 * completely unmodified — this is a new, additive module living alongside
 * them. `StructuredComparisonBindingResolver` now prefers a rule's
 * pre-computed `structuredCondition` (built by `@xo/compiler` at
 * extraction time via this module) when present, and falls back to the
 * original narrow grammar otherwise — see that file's own doc comment for
 * the exact precedence.
 *
 * Same conservatism and technique as `comparison-grammar.ts` and
 * `@xo/compiler`'s `rule-pattern-parser.ts`: manual phrase-table matching
 * on explicit word boundaries, no regex-as-NLU, no stemming, no
 * synonym-guessing. Anything this grammar cannot confidently resolve
 * returns `undefined` — never a best-effort/partial structure. This is
 * the module's single most important property, restated from the Phase 2
 * brief: "structured semantic output must be MORE trustworthy than the
 * unstructured fallback."
 *
 * What this module deliberately does NOT do:
 *   - No temporal *logic engine* — temporal relations are STRUCTURED
 *     (relation + amount/unit or anchor), never evaluated/executed. See
 *     `structured-comparison-resolver.ts`'s doc comment for why a
 *     structured condition containing a temporal leaf cannot lower to a
 *     `deterministic_rule` binding today.
 *   - No confidence-gated execution, no runtime authorization semantics.
 *   - No general natural-language AST. Only the shapes enumerated below.
 */
export type StructuredComparisonOperator = '>' | '<' | '>=' | '<=' | '==' | '!=';
/** `"the claim amount exceeds INR 10,000"` -> `{field, operator: '>', value: 10000, unit: 'INR'}`. */
export interface StructuredNumericComparison {
    readonly type: 'comparison';
    readonly field: string;
    readonly operator: StructuredComparisonOperator;
    readonly value: number;
    readonly unit?: string;
}
/** `"the claim status is approved"` / `"the claim is not covered"` -> a closed-vocabulary state assertion, never a guessed adjective — see {@link KNOWN_CATEGORICAL_STATES}. */
export interface StructuredCategoricalCondition {
    readonly type: 'categorical';
    readonly field: string;
    readonly operator: '==' | '!=';
    readonly value: string;
}
/** `"between 100 and 500"` / `"from 100 to 500"` -> both bounds inclusive, the only range shape this grammar accepts. */
export interface StructuredRangeCondition {
    readonly type: 'range';
    readonly field: string;
    readonly min: number;
    readonly max: number;
    readonly unit?: string;
}
export type StructuredTemporalRelation = 'within' | 'after' | 'before' | 'during';
export type StructuredTemporalUnit = 'day' | 'days' | 'month' | 'months' | 'year' | 'years';
/**
 * `"within 30 days"` -> `{relation: 'within', amount: 30, unit: 'days'}`;
 * `"before renewal"` -> `{relation: 'before', anchor: 'renewal'}`. Exactly
 * one of `amount`/`unit` or `anchor` is present — never both, never
 * neither (a temporal phrase this grammar can't resolve to one of those
 * two shapes is not parsed at all, per the module's "do not guess" rule).
 * Deliberately structure-only: nothing here evaluates a duration against
 * a wall clock or a reference date. See the module doc comment.
 */
export interface StructuredTemporalCondition {
    readonly type: 'temporal';
    readonly relation: StructuredTemporalRelation;
    readonly amount?: number;
    readonly unit?: StructuredTemporalUnit;
    readonly anchor?: string;
}
export type StructuredLeafCondition = StructuredNumericComparison | StructuredCategoricalCondition | StructuredRangeCondition | StructuredTemporalCondition;
/** All operands must hold. Built only when every operand independently parses — a partially-parseable conjunction is not emitted as a smaller-but-wrong conjunction, see `parseStructuredCondition`. */
export interface StructuredConjunction {
    readonly type: 'and';
    readonly operands: readonly StructuredCondition[];
}
/** At least one operand must hold. Same all-or-nothing parsing discipline as {@link StructuredConjunction}. */
export interface StructuredDisjunction {
    readonly type: 'or';
    readonly operands: readonly StructuredCondition[];
}
export type StructuredCondition = StructuredLeafCondition | StructuredConjunction | StructuredDisjunction;
/** `"deny the claim"` -> `{action: 'deny', target: 'the claim'}`. Only a closed, known action-verb vocabulary is recognized — see {@link KNOWN_ACTION_VERBS}. */
export interface StructuredAction {
    readonly type: 'action';
    readonly action: string;
    readonly target?: string;
}
/** One `UNLESS`/`EXCEPT WHEN` clause, structured where its own text independently parses as a `StructuredCondition`. The clause's raw text (`ReasoningNode.exceptionConditions`) is unaffected by and independent of this — this is purely an additional, best-effort structured projection of the same text, never a replacement for it. */
export interface StructuredExceptionCondition {
    readonly raw: string;
    readonly condition?: StructuredCondition;
}
/**
 * The Phase 2 entry point. Tries the whole input as a single atom first
 * (this is what makes `"between 100 and 500"` resolve as one range rather
 * than being torn apart by AND-splitting below). Only if that fails does
 * it look for top-level `"and"`/`"or"` — and only when EXACTLY ONE of the
 * two connectives is present in the text: mixed `"A and B or C"` has
 * ambiguous precedence this grammar refuses to guess at, and is left
 * entirely unstructured, per the module's "do not guess semantics" rule.
 * A conjunction/disjunction is only ever built when every single operand
 * independently parses — one unparseable operand fails the whole
 * expression rather than silently dropping it (a decision rule missing
 * one of its real conditions is not a smaller-but-correct rule, it is a
 * wrong one — same principle `structured-comparison-resolver.ts` already
 * documents for a contract's rule list).
 */
export declare function parseStructuredCondition(text: string): StructuredCondition | undefined;
/**
 * `"deny the claim"` -> `{action: 'deny', target: 'the claim'}`.
 * `"apply a penalty fee"` -> `{action: 'apply', target: 'a penalty fee'}`.
 * The verb must be the FIRST word (sentence-initial imperative shape,
 * mirroring `rule-pattern-parser.ts#startsWithDecisionVerb`'s own
 * convention) and must be in the closed {@link KNOWN_ACTION_VERBS} list —
 * an unrecognized leading verb, or no leading verb at all (e.g. a bare
 * passive-voice fact like `"Terrorism cover is excluded"`, which has no
 * imperative shape), returns `undefined` rather than guessing. The target
 * is kept verbatim (leading article included) as the useful, human-
 * readable object phrase — this function does not attempt to further
 * decompose it.
 */
export declare function parseStructuredAction(text: string): StructuredAction | undefined;
/** Convenience used by callers that don't care which shape the leading word implies — never used by this module itself, kept for `@xo/compiler`'s per-node-type dispatch table (`structured-semantics.ts`) rather than re-implemented there. */
export declare function normalizeLeadingArticle(text: string): string;
//# sourceMappingURL=structured-expression-grammar.d.ts.map