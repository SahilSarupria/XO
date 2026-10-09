/**
 * A tiny, closed, deterministic grammar for exactly one shape of
 * condition: `"<field phrase> <comparison phrase> <numeric value>"`
 * (e.g. `"the claimed loss amount exceeds $10,000"`). This is
 * deliberately NOT a natural-language understanding component — it is a
 * fixed phrase table plus a numeric-literal parser, in the same spirit
 * and with the same conservatism as `@xo/compiler`'s
 * `rule-pattern-parser.ts` (manual, no regex-as-NLU, false negatives
 * preferred over false positives). Anything outside this exact shape —
 * compound conditions, non-numeric comparisons, an unrecognized
 * comparison phrase — returns `undefined`, never a best-effort guess.
 *
 * The accepted comparison phrasings (exhaustive, closed list):
 *
 *   "exceeds", "is more than", "is greater than"   -> >
 *   "is less than", "is under"                     -> <
 *   "is at least"                                  -> >=
 *   "is at most"                                   -> <=
 *   "equals", "is equal to"                         -> ==
 *   "is not equal to", "does not equal"             -> !=
 *
 * Phrase matching is on word boundaries (never matches inside a longer
 * word). Among all phrases that occur anywhere in the text, the
 * leftmost-occurring one is used as the split point (ties at the same
 * position broken by the longer/more specific phrase) — so a second
 * comparison phrase occurring later in the text is preserved in the
 * right-hand side and correctly triggers the compound-condition
 * rejection below, rather than a longer-but-later phrase being picked
 * over an earlier shorter one.
 */
export type ComparisonOperator = '>' | '<' | '>=' | '<=' | '==' | '!=';
export interface ParsedComparisonCondition {
    readonly fieldPhrase: string;
    readonly operator: ComparisonOperator;
    readonly value: number;
}
/**
 * Parses `text` as `"<field> <comparison phrase> <number>"`. Returns
 * `undefined` for anything that doesn't match this exact shape —
 * multiple comparison phrases, no comparison phrase, a non-numeric
 * right-hand side, or an empty field phrase.
 */
export declare function parseComparisonCondition(text: string): ParsedComparisonCondition | undefined;
export declare function evaluateComparison(operator: ComparisonOperator, actual: number, expected: number): boolean;
//# sourceMappingURL=comparison-grammar.d.ts.map