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

interface PhraseEntry {
  readonly phrase: string;
  readonly operator: ComparisonOperator;
}

const COMPARISON_PHRASES: readonly PhraseEntry[] = [
  { phrase: 'exceeds', operator: '>' },
  { phrase: 'is more than', operator: '>' },
  { phrase: 'is greater than', operator: '>' },
  { phrase: 'is less than', operator: '<' },
  { phrase: 'is under', operator: '<' },
  { phrase: 'is at least', operator: '>=' },
  { phrase: 'is at most', operator: '<=' },
  { phrase: 'is not equal to', operator: '!=' },
  { phrase: 'does not equal', operator: '!=' },
  { phrase: 'is equal to', operator: '==' },
  { phrase: 'equals', operator: '==' },
];

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

/** First word-boundary occurrence of `phrase` in `lowerText`, or -1. Both must already be lowercase. */
function indexOfPhraseBoundary(lowerText: string, phrase: string): number {
  let from = 0;
  for (;;) {
    const idx = lowerText.indexOf(phrase, from);
    if (idx === -1) return -1;
    const before = idx > 0 ? lowerText[idx - 1] : undefined;
    const after = idx + phrase.length < lowerText.length ? lowerText[idx + phrase.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return idx;
    from = idx + 1;
  }
}

function findOperatorPhrase(lowerText: string): { readonly entry: PhraseEntry; readonly index: number } | undefined {
  let best: { readonly entry: PhraseEntry; readonly index: number } | undefined;
  for (const entry of COMPARISON_PHRASES) {
    const idx = indexOfPhraseBoundary(lowerText, entry.phrase);
    if (idx === -1) continue;
    // Leftmost occurrence wins; a tie at the same index is broken by the
    // longer phrase (the more specific match — e.g. "is not equal to"
    // over a coincidentally-matching shorter phrase starting at the same
    // position), never by declaration order alone.
    if (best === undefined || idx < best.index || (idx === best.index && entry.phrase.length > best.entry.phrase.length)) {
      best = { entry, index: idx };
    }
  }
  return best;
}

/** `"$10,000"` / `"10000"` / `"10,000.50"` -> `10000` / `10000.5` — the only numeric-literal shapes this grammar accepts (bare digits, optional `$` prefix, optional comma grouping, optional decimal). Anything else (a spelled-out number, a range, a unit other than a bare `$`) is not parsed and returns `undefined`. */
function parseNumericLiteral(text: string): number | undefined {
  const trimmed = text.trim();
  const match = /^\$?(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?$/.exec(trimmed);
  if (!match) return undefined;
  const withoutCommas = trimmed.replace(/^\$/, '').replace(/,/g, '');
  const value = Number(withoutCommas);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Parses `text` as `"<field> <comparison phrase> <number>"`. Returns
 * `undefined` for anything that doesn't match this exact shape —
 * multiple comparison phrases, no comparison phrase, a non-numeric
 * right-hand side, or an empty field phrase.
 */
export function parseComparisonCondition(text: string): ParsedComparisonCondition | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const lower = trimmed.toLowerCase();

  const found = findOperatorPhrase(lower);
  if (!found) return undefined;

  const fieldPhrase = trimmed.slice(0, found.index).trim();
  const valueText = trimmed.slice(found.index + found.entry.phrase.length).trim();
  if (fieldPhrase.length === 0 || valueText.length === 0) return undefined;

  // Reject a second comparison phrase anywhere in the remainder — a
  // compound condition ("X exceeds 10 and Y is less than 5") is outside
  // this grammar's closed single-comparison shape.
  if (findOperatorPhrase(valueText.toLowerCase()) !== undefined) return undefined;

  const value = parseNumericLiteral(valueText);
  if (value === undefined) return undefined;

  return { fieldPhrase, operator: found.entry.operator, value };
}

export function evaluateComparison(operator: ComparisonOperator, actual: number, expected: number): boolean {
  switch (operator) {
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
    case '==':
      return actual === expected;
    case '!=':
      return actual !== expected;
  }
}
