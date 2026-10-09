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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
 *
 * M1.3: a duration shape (`amount`+`unit` present) MAY also carry
 * `field` — the short reference phrase the duration was measured
 * against, e.g. `"received within 7 days of the reported loss date"` ->
 * `field: "reported loss date"`. Sourced verbatim from the trailing
 * text after the duration, never fabricated — same discipline as every
 * other atom type's `field`. Only populated when that trailing text is
 * short enough to confidently be a reference phrase (see
 * `parseTemporalDuration`'s own word-count cap); otherwise left
 * `undefined`, in which case `StructuredComparisonBindingResolver`
 * cannot derive a field key and correctly leaves the rule unresolved
 * rather than guessing one. `field` is never populated for the anchor
 * shape (`{relation, anchor}`) — that shape has no duration to compare
 * against a field's runtime value in the first place.
 */
export interface StructuredTemporalCondition {
  readonly type: 'temporal';
  readonly relation: StructuredTemporalRelation;
  readonly amount?: number;
  readonly unit?: StructuredTemporalUnit;
  readonly anchor?: string;
  readonly field?: string;
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

// ---------------------------------------------------------------------------
// Shared low-level helpers (self-contained — no cross-import from
// comparison-grammar.ts, so that module's tested behavior is provably
// unaffected by anything in this one).
// ---------------------------------------------------------------------------

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

/** First word-boundary occurrence of `phrase` in `lowerText` at or after `fromIndex`, or -1. Both `lowerText` and `phrase` must already be lowercase. */
function indexOfPhraseBoundary(lowerText: string, phrase: string, fromIndex = 0): number {
  let from = fromIndex;
  for (;;) {
    const idx = lowerText.indexOf(phrase, from);
    if (idx === -1) return -1;
    const before = idx > 0 ? lowerText[idx - 1] : undefined;
    const after = idx + phrase.length < lowerText.length ? lowerText[idx + phrase.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return idx;
    from = idx + 1;
  }
}

/** Every word-boundary occurrence of `phrase` in `lowerText` (not just the first) — used to detect mixed AND/OR precedence, which this grammar refuses to guess at (see `splitTopLevel`). */
function allPhraseBoundaryIndices(lowerText: string, phrase: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = indexOfPhraseBoundary(lowerText, phrase, from);
    if (idx === -1) return out;
    out.push(idx);
    from = idx + 1;
  }
}

/**
 * A handful of `COMPARISON_PHRASES` entries (`"is less than or equal
 * to"`, `"is greater than or equal to"`) contain the literal word `"or"`
 * as part of a *fixed* comparison phrase, not as a logical connective.
 * `parseStructuredCondition`'s top-level AND/OR connective scan must not
 * mistake that for a real disjunction — e.g. `"claim amount is less than
 * or equal to INR 10,000 and documents are present"` genuinely is a
 * single AND of two operands, not an unparseable "mixed and/or"
 * expression. This blanks out (same-length, so indices elsewhere are
 * unaffected) every occurrence of such a phrase before the connective
 * scan runs — used ONLY for that scan, never for atom parsing itself
 * (which still sees, and needs, the original text). Declared after
 * `COMPARISON_PHRASES` (below) since it's derived from that table.
 */
let orContainingComparisonPhrasesCache: readonly string[] | undefined;
function orContainingComparisonPhrases(): readonly string[] {
  if (orContainingComparisonPhrasesCache === undefined) {
    orContainingComparisonPhrasesCache = COMPARISON_PHRASES.map((p) => p.phrase).filter((phrase) => / or /.test(` ${phrase} `));
  }
  return orContainingComparisonPhrasesCache;
}

function maskOrContainingComparisonPhrases(lowerText: string): string {
  let masked = lowerText;
  for (const phrase of orContainingComparisonPhrases()) {
    masked = masked.split(phrase).join(' '.repeat(phrase.length));
  }
  return masked;
}

function stripTrailingPunct(text: string): string {
  return text.replace(/[.,;:]+$/, '').trim();
}

/** True if `connective` (`"and"`/`"or"`) occurs anywhere in `text` at a word boundary. Used to reject a candidate atom whose computed `field`/pre-cue text secretly spans a logical connective — see the callers below for why this matters (a field is a short noun phrase, never a clause containing "or"/"and"). */
function containsTopLevelConnective(text: string, connective: 'and' | 'or'): boolean {
  return indexOfPhraseBoundary(text.toLowerCase(), connective) !== -1;
}

/** Strips a single trailing bare copula word (`"is"`/`"are"`) from a field phrase, e.g. `"the claim amount is"` -> `"the claim amount"`. Used by `parseRangeAtom`, whose `"between"`/`"from"` cue is typically itself preceded by a copula that isn't part of the field name. */
function stripTrailingCopula(field: string): string {
  const match = /^(.*?)\s+(?:is|are)$/i.exec(field.trim());
  return match ? match[1]!.trim() : field.trim();
}

/** Strips a trailing copula optionally followed by an article (`"is"`, `"are"`, `"is a"`, `"is an"`, `"are a"`) from a field phrase, e.g. `"the deposit is a"` -> `"the deposit"`. Used by `parseComparisonAtom` for phrases like `"minimum of"`/`"maximum of"` whose cue is conventionally preceded by `"is a"` (`"the deposit is a minimum of 100"`). */
function stripTrailingCopulaAndArticle(field: string): string {
  const match = /^(.*?)\s+(?:is|are)(?:\s+(?:a|an))?$/i.exec(field.trim());
  return match ? match[1]!.trim() : field.trim();
}

/** `"$10,000"` / `"INR 10,000"` / `"10000 USD"` / `"10000.5"` -> `{value, unit}` — the only numeric-literal shapes this grammar accepts. A currency SYMBOL prefix, a leading 3-letter currency CODE (space-separated), or a trailing 3-letter currency CODE (space-separated) may accompany the digits; anything else (spelled-out numbers, unrecognized units, multiple units) is not parsed. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { $: 'USD', '₹': 'INR', '£': 'GBP', '€': 'EUR' };
const CURRENCY_CODES = new Set(['USD', 'INR', 'GBP', 'EUR', 'JPY', 'AUD', 'CAD']);

function parseNumericLiteralWithUnit(text: string): { readonly value: number; readonly unit?: string } | undefined {
  const trimmed = stripTrailingPunct(text.trim());
  if (trimmed.length === 0) return undefined;

  // Leading currency symbol, e.g. "$10,000".
  const symbolChar = trimmed[0];
  if (symbolChar !== undefined && CURRENCY_SYMBOLS[symbolChar] !== undefined) {
    const rest = trimmed.slice(1).trim();
    const numeric = parseBareNumericLiteral(rest);
    if (numeric === undefined) return undefined;
    return { value: numeric, unit: CURRENCY_SYMBOLS[symbolChar] };
  }

  // Leading currency code, e.g. "INR 10,000".
  const leadMatch = /^([A-Za-z]{3})\s+(.+)$/.exec(trimmed);
  if (leadMatch) {
    const code = leadMatch[1]!.toUpperCase();
    if (CURRENCY_CODES.has(code)) {
      const numeric = parseBareNumericLiteral(leadMatch[2]!);
      if (numeric === undefined) return undefined;
      return { value: numeric, unit: code };
    }
  }

  // Trailing currency code, e.g. "10000 USD".
  const trailMatch = /^(.+?)\s+([A-Za-z]{3})$/.exec(trimmed);
  if (trailMatch) {
    const code = trailMatch[2]!.toUpperCase();
    if (CURRENCY_CODES.has(code)) {
      const numeric = parseBareNumericLiteral(trailMatch[1]!);
      if (numeric === undefined) return undefined;
      return { value: numeric, unit: code };
    }
  }

  const bare = parseBareNumericLiteral(trimmed);
  if (bare === undefined) return undefined;
  return { value: bare };
}

function parseBareNumericLiteral(text: string): number | undefined {
  const trimmed = text.trim();
  const match = /^(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?$/.exec(trimmed);
  if (!match) return undefined;
  const withoutCommas = trimmed.replace(/,/g, '');
  const value = Number(withoutCommas);
  return Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Numeric comparison
// ---------------------------------------------------------------------------

interface ComparisonPhraseEntry {
  readonly phrase: string;
  readonly operator: StructuredComparisonOperator;
}

/**
 * A superset of `comparison-grammar.ts`'s phrase table (per the Phase 2
 * brief's §"Numeric comparisons"). Deliberately independent of that
 * table, not a shared import — `comparison-grammar.ts` is frozen,
 * regression-tested, closed-form grammar; this list is free to grow with
 * Phase 2's broader vocabulary (`"above"`, `"over"`, `"minimum"`, ...)
 * without touching it. Every bare-word phrase here (`"above"`, `"below"`,
 * `"over"`, `"under"`, `"minimum"`, `"maximum"`) is safe from false
 * positives on ordinary prose (e.g. "excluded ... under the policy")
 * because the right-hand side must additionally parse as a strict numeric
 * literal (see `parseComparisonAtom`) — a non-numeric right-hand side
 * fails the match entirely, regardless of which phrase was found.
 */
const COMPARISON_PHRASES: readonly ComparisonPhraseEntry[] = [
  { phrase: 'exceeds', operator: '>' },
  { phrase: 'is more than', operator: '>' },
  { phrase: 'is greater than or equal to', operator: '>=' },
  { phrase: 'is greater than', operator: '>' },
  { phrase: 'is above', operator: '>' },
  { phrase: 'is over', operator: '>' },
  { phrase: 'above', operator: '>' },
  { phrase: 'over', operator: '>' },
  { phrase: 'is less than or equal to', operator: '<=' },
  { phrase: 'is less than', operator: '<' },
  { phrase: 'is under', operator: '<' },
  { phrase: 'is below', operator: '<' },
  { phrase: 'under', operator: '<' },
  { phrase: 'below', operator: '<' },
  { phrase: 'is at least', operator: '>=' },
  { phrase: 'at least', operator: '>=' },
  { phrase: 'minimum of', operator: '>=' },
  { phrase: 'is at most', operator: '<=' },
  { phrase: 'at most', operator: '<=' },
  { phrase: 'maximum of', operator: '<=' },
  { phrase: 'is not equal to', operator: '!=' },
  { phrase: 'does not equal', operator: '!=' },
  { phrase: 'is equal to', operator: '==' },
  { phrase: 'equals', operator: '==' },
];

function findComparisonPhrase(lowerText: string): { readonly entry: ComparisonPhraseEntry; readonly index: number } | undefined {
  let best: { readonly entry: ComparisonPhraseEntry; readonly index: number } | undefined;
  for (const entry of COMPARISON_PHRASES) {
    const idx = indexOfPhraseBoundary(lowerText, entry.phrase);
    if (idx === -1) continue;
    if (best === undefined || idx < best.index || (idx === best.index && entry.phrase.length > best.entry.phrase.length)) {
      best = { entry, index: idx };
    }
  }
  return best;
}

function parseComparisonAtom(text: string): StructuredNumericComparison | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const lower = trimmed.toLowerCase();

  const found = findComparisonPhrase(lower);
  if (!found) return undefined;

  const field = stripTrailingCopulaAndArticle(stripTrailingPunct(trimmed.slice(0, found.index)));
  const valueText = trimmed.slice(found.index + found.entry.phrase.length).trim();
  if (field.length === 0 || valueText.length === 0) return undefined;

  // A field spanning a top-level "and"/"or" means the real structure is a
  // conjunction/disjunction whose operands merely happen to put a
  // comparison phrase later in the string (e.g. "A or the claim is under
  // 100") — that is not a single comparison atom, and treating it as one
  // would silently swallow the "A or" prefix into a nonsensical field.
  if (containsTopLevelConnective(field, 'and') || containsTopLevelConnective(field, 'or')) return undefined;

  // A second comparison phrase in the remainder means this isn't a single comparison atom.
  if (findComparisonPhrase(valueText.toLowerCase()) !== undefined) return undefined;

  const numeric = parseNumericLiteralWithUnit(valueText);
  if (numeric === undefined) return undefined;

  return { type: 'comparison', field, operator: found.entry.operator, value: numeric.value, ...(numeric.unit !== undefined ? { unit: numeric.unit } : {}) };
}

// ---------------------------------------------------------------------------
// Threshold / range
// ---------------------------------------------------------------------------

/** `"between 100 and 500"` / `"from 100 to 500"`. Tried before generic AND-splitting so a range's own internal `"and"`/`"to"` is never mistaken for a conjunction — see `parseStructuredCondition`. */
function parseRangeAtom(text: string): StructuredRangeCondition | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  const betweenIdx = indexOfPhraseBoundary(lower, 'between');
  if (betweenIdx !== -1) {
    const field = stripTrailingCopula(stripTrailingPunct(trimmed.slice(0, betweenIdx)));
    const rest = trimmed.slice(betweenIdx + 'between'.length).trim();
    const andIdx = indexOfPhraseBoundary(rest.toLowerCase(), 'and');
    if (field.length === 0 || andIdx === -1 || containsTopLevelConnective(field, 'or') || containsTopLevelConnective(field, 'and')) return undefined;
    const minText = rest.slice(0, andIdx).trim();
    const maxText = rest.slice(andIdx + 'and'.length).trim();
    const min = parseNumericLiteralWithUnit(minText);
    const max = parseNumericLiteralWithUnit(maxText);
    if (min === undefined || max === undefined || min.value > max.value) return undefined;
    const unit = min.unit ?? max.unit;
    return { type: 'range', field, min: min.value, max: max.value, ...(unit !== undefined ? { unit } : {}) };
  }

  const fromIdx = indexOfPhraseBoundary(lower, 'from');
  if (fromIdx !== -1) {
    const field = stripTrailingCopula(stripTrailingPunct(trimmed.slice(0, fromIdx)));
    const rest = trimmed.slice(fromIdx + 'from'.length).trim();
    const toIdx = indexOfPhraseBoundary(rest.toLowerCase(), 'to');
    if (field.length === 0 || toIdx === -1 || containsTopLevelConnective(field, 'or') || containsTopLevelConnective(field, 'and')) return undefined;
    const minText = rest.slice(0, toIdx).trim();
    const maxText = rest.slice(toIdx + 'to'.length).trim();
    const min = parseNumericLiteralWithUnit(minText);
    const max = parseNumericLiteralWithUnit(maxText);
    if (min === undefined || max === undefined || min.value > max.value) return undefined;
    const unit = min.unit ?? max.unit;
    return { type: 'range', field, min: min.value, max: max.value, ...(unit !== undefined ? { unit } : {}) };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Categorical / boolean state
// ---------------------------------------------------------------------------

/**
 * Closed vocabulary of recognized state adjectives (per the Phase 2
 * brief's §"Boolean / categorical conditions" plus the real
 * `burglary-policy.pdf` vocabulary this grammar was validated against —
 * "excluded"/"covered" are the dominant real-source shape). A state word
 * outside this list is never guessed at; the whole categorical parse
 * fails and the caller's `condition`/`action` text is left unstructured.
 */
const KNOWN_CATEGORICAL_STATES = new Set([
  'approved',
  'active',
  'inactive',
  'cancelled',
  'canceled',
  'applicable',
  'valid',
  'invalid',
  'excluded',
  'covered',
  'required',
  'mandatory',
  'void',
  'expired',
  'pending',
  // M1.1 addition — closed-vocabulary "document/prerequisite present or
  // absent" states, needed to represent real policy language like "all
  // required documents are present" (as an AND-operand alongside a
  // numeric comparison). Same discipline as every other entry here: a
  // fixed, closed word, never a guessed adjective.
  'present',
  'missing',
  // M1.2 addition — closed-vocabulary claim-outcome state, needed for
  // "a claim is denied" (real policy §9.4: "When a claim is denied, the
  // system must record the denial reason..."). Evidence-driven: added
  // because this exact word is the sole blocker on an already-clean,
  // already-linked rule — not speculatively.
  'denied',
  'eligible',
  'payable',
  'correct',
  'incorrect',
  'complete',
  'incomplete',
  'satisfied',
  // Categorical Equality Condition milestone — evidence-driven, matching
  // this set's established precedent (M1.1/M1.2 above): "flood" and
  // "theft" are the sole blocker on two already-clean, already-linked
  // real rules in `XO_Commercial_Property_Test_Policy_Compatible.pdf`
  // ("the loss type is flood" / "the loss type is theft"), sitting
  // alongside an already-resolving numeric threshold rule
  // ("the claim amount is greater than INR 100,000") in the same
  // multi-rule capability — the numeric rule already resolves in
  // isolation (as its own M1.1-minted capability), proving the evidence
  // quality is sufficient; only these two category-label words were
  // missing from this closed vocabulary. Not a general "any noun after
  // is" allowance — exactly two fixed words, added because the real
  // corpus requires them, per this file's own stated discipline.
  'flood',
  'theft',
]);

interface CopulaEntry {
  readonly phrase: string;
  readonly negated: boolean;
}

const COPULAS: readonly CopulaEntry[] = [
  { phrase: 'is not', negated: true },
  { phrase: 'are not', negated: true },
  { phrase: 'is', negated: false },
  { phrase: 'are', negated: false },
];

/**
 * Matches the categorical state word immediately after a copula. The
 * immediate next word is checked first, exactly as before. If that word is
 * not itself a recognized state but looks like a single adverbial modifier
 * (`/^[a-z]+ly$/`, e.g. `"materially"`, `"clearly"`), exactly one bounded
 * hop is allowed: the word AFTER the modifier is checked instead. This
 * covers the common `"is materially incorrect"` / `"is clearly excluded"`
 * shape without turning this into free-form adjective-phrase parsing —
 * the modifier itself is never part of the returned `value`, at most one
 * modifier is ever skipped, and a second unrecognized word (whether or not
 * it looks like an adverb) is never chased further. Returns `undefined` if
 * neither the first word nor the bounded second word is a recognized
 * {@link KNOWN_CATEGORICAL_STATES} entry.
 */
function matchCategoricalStateWord(afterCopula: string): string | undefined {
  const firstMatch = /^([A-Za-z]+)/.exec(afterCopula);
  if (!firstMatch) return undefined;
  const first = firstMatch[1]!.toLowerCase();
  if (KNOWN_CATEGORICAL_STATES.has(first)) return first;

  // Exactly one bounded adverbial hop: only a plain "-ly" word, and only
  // when the very next word is itself already a recognized state — never
  // guessed, never chained past a second word.
  if (!/^[a-z]+ly$/.test(first)) return undefined;
  const rest = afterCopula.slice(firstMatch[0].length).trimStart();
  const secondMatch = /^([A-Za-z]+)/.exec(rest);
  if (!secondMatch) return undefined;
  const second = secondMatch[1]!.toLowerCase();
  return KNOWN_CATEGORICAL_STATES.has(second) ? second : undefined;
}

/**
 * `"<field> is <state>"` / `"<field> is not <state>"` (and the `"are"`
 * plural form) -> `{field, operator, value: state}`. Matched at the
 * LEFTMOST copula boundary so a field phrase itself may safely contain
 * `"and"`/other connective words (e.g. `"Theft and RSMD is excluded"` ->
 * field `"Theft and RSMD"`) — this is why categorical parsing, like every
 * other atom parser here, is tried on the WHOLE input before any
 * AND/OR-splitting is attempted (see `parseStructuredCondition`). The word
 * immediately after the copula is checked against
 * {@link KNOWN_CATEGORICAL_STATES} (with the single bounded adverbial hop
 * described in {@link matchCategoricalStateWord}); any trailing qualifier
 * after the matched state word (e.g. `"...excluded from scope of cover
 * under the policy"`) is real source text that simply isn't part of the
 * structured `field`/`operator`/`value` shape — it is not lost (the raw
 * condition/action string is preserved unchanged elsewhere), just not
 * further structured.
 */
function parseCategoricalAtom(text: string): StructuredCategoricalCondition | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // A field is allowed to contain a top-level "and" for a genuine named
  // category ("Theft and RSMD is excluded"), but NOT when the "and"
  // actually separates two independently-parseable conditions ("the
  // deductible is at least 250 and the claim is approved" is a
  // conjunction of a comparison and a categorical condition, not one
  // categorical atom whose field happens to contain "and"). Deferring to
  // the AND-split path in `parseStructuredCondition` in that case is what
  // keeps this grammar's "and" handling both real-corpus-accurate (named
  // categories) and precision-safe (no swallowed conjunctions).
  if (hasIndependentConjunctionSplit(trimmed)) return undefined;

  // Collect every copula occurrence (not just the leftmost) so that, e.g.,
  // "the deductible is at least 250 and the claim is approved" — where the
  // FIRST "is" is not followed by a recognized state word ("at") — still
  // has a chance to match a LATER "is <state>" occurrence rather than
  // failing outright on the first candidate. Sorted leftmost-first so the
  // earliest genuinely-matching copula wins (deterministic, no ambiguity
  // between multiple valid matches in the same string).
  const candidates: { readonly copula: CopulaEntry; readonly index: number }[] = [];
  for (const copula of COPULAS) {
    let from = 0;
    for (;;) {
      const idx = indexOfPhraseBoundary(lower, copula.phrase, from);
      if (idx === -1) break;
      candidates.push({ copula, index: idx });
      from = idx + 1;
    }
  }
  candidates.sort((a, b) => a.index - b.index || b.copula.phrase.length - a.copula.phrase.length);

  for (const candidate of candidates) {
    const field = stripTrailingPunct(trimmed.slice(0, candidate.index));
    if (field.length === 0) continue;
    // A field spanning a top-level "or" means the real structure is a
    // disjunction whose second operand happens to contain this copula —
    // not a single categorical atom (mirrors the same guard in
    // `parseComparisonAtom`). A top-level "and" is intentionally still
    // allowed through: real source fields legitimately contain "and" as
    // part of a named category (e.g. "Theft and RSMD is excluded").
    if (containsTopLevelConnective(field, 'or')) continue;

    const afterCopula = trimmed.slice(candidate.index + candidate.copula.phrase.length).trimStart();
    const stateWord = matchCategoricalStateWord(afterCopula);
    if (stateWord === undefined) continue;

    return { type: 'categorical', field, operator: candidate.copula.negated ? '!=' : '==', value: stateWord };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Temporal (structure only — see module doc comment)
// ---------------------------------------------------------------------------

const TEMPORAL_UNIT_WORDS = new Set(['day', 'days', 'month', 'months', 'year', 'years']);

/** `"within 30 days"` / `"after 7 days"` — a leading relation cue followed directly by `<number> <unit>`. */
/**
 * Duration shape: `"<relation> <amount> <unit>[ <trailing reference phrase>]"`.
 *
 * M1.3 additions, both narrowly evidence-driven by
 * XO_Commercial_Property_Test_Policy_Compatible.pdf §8.1/§8.2's exact
 * wording:
 * - `"more than"` is recognized as an alternate surface form of the
 *   `'after'` relation — "more than 7 days" and "after 7 days" mean the
 *   same thing for a duration threshold (`> amount`). Reduces to the
 *   existing `'after'` relation rather than adding a new one.
 * - An optional `"calendar "` filler word between the number and the
 *   unit (`"7 calendar days"`) is skipped. Deliberately only this one
 *   specific, evidence-grounded word — not a generic filler-word skip,
 *   which would reduce precision for every other duration phrase this
 *   grammar parses.
 * - The text trailing the matched `<amount> <unit>` (e.g. `"of the
 *   reported loss date"`, `"after the reported loss date"`) is captured
 *   as `field` (see {@link StructuredTemporalCondition}'s doc comment),
 *   after stripping a single leading connector word (`"of"`, `"after"`,
 *   `"before"`, `"during"`) and a leading `"the "`, and capped at 5
 *   words — long enough for the real policy's "reported loss date" (3
 *   words) with headroom, short enough to still refuse a long unrelated
 *   trailing clause rather than sweep it in as a field name (mirrors
 *   `parseTemporalAnchor`'s existing word-count cap).
 */
function parseTemporalDuration(text: string): StructuredTemporalCondition | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const relationPhrases: readonly { phrase: string; relation: StructuredTemporalRelation }[] = [
    { phrase: 'within', relation: 'within' },
    { phrase: 'more than', relation: 'after' },
    { phrase: 'after', relation: 'after' },
  ];
  for (const { phrase, relation } of relationPhrases) {
    const idx = indexOfPhraseBoundary(lower, phrase);
    if (idx === -1) continue;
    const before = trimmed.slice(0, idx);
    if (containsTopLevelConnective(before, 'and') || containsTopLevelConnective(before, 'or')) continue;
    const rest = trimmed.slice(idx + phrase.length).trim();
    const match = /^(\d+)\s+(?:calendar\s+)?([A-Za-z]+)/.exec(rest);
    if (!match) continue;
    const amount = Number(match[1]);
    const unitWord = match[2]!.toLowerCase();
    if (!Number.isFinite(amount) || !TEMPORAL_UNIT_WORDS.has(unitWord)) continue;

    let field: string | undefined;
    const trailing = rest.slice(match[0].length).trim();
    if (trailing.length > 0) {
      let candidate = trailing;
      for (const connector of ['of ', 'after ', 'before ', 'during ']) {
        if (candidate.toLowerCase().startsWith(connector)) {
          candidate = candidate.slice(connector.length).trim();
          break;
        }
      }
      candidate = stripTrailingPunct(candidate);
      if (candidate.toLowerCase().startsWith('the ')) candidate = candidate.slice(4).trim();
      const wordCount = candidate.split(/\s+/).filter((w) => w.length > 0).length;
      if (candidate.length > 0 && wordCount > 0 && wordCount <= 5) field = candidate;
    }

    return { type: 'temporal', relation, amount, unit: unitWord as StructuredTemporalUnit, ...(field !== undefined ? { field } : {}) };
  }
  return undefined;
}

/** `"before renewal"` / `"during the policy period"` — a leading relation cue followed by a short, non-numeric anchor phrase (no more than a few words, so a long unrelated clause after "before"/"during" is not swept in as an anchor). */
function parseTemporalAnchor(text: string): StructuredTemporalCondition | undefined {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const relations: readonly StructuredTemporalRelation[] = ['before', 'during'];
  for (const relation of relations) {
    const idx = indexOfPhraseBoundary(lower, relation);
    if (idx === -1) continue;
    const before = trimmed.slice(0, idx);
    if (containsTopLevelConnective(before, 'and') || containsTopLevelConnective(before, 'or')) continue;
    let anchor = stripTrailingPunct(trimmed.slice(idx + relation.length).trim());
    if (anchor.toLowerCase().startsWith('the ')) anchor = anchor.slice(4).trim();
    if (anchor.length === 0) continue;
    const wordCount = anchor.split(/\s+/).filter((w) => w.length > 0).length;
    if (wordCount > 4) continue; // too long to confidently be a bare anchor phrase — leave unstructured
    if (/\d/.test(anchor)) continue; // a numeric anchor is `parseTemporalDuration`'s shape, not this one
    return { type: 'temporal', relation, anchor };
  }
  return undefined;
}

function parseTemporalAtom(text: string): StructuredTemporalCondition | undefined {
  return parseTemporalDuration(text) ?? parseTemporalAnchor(text);
}

// ---------------------------------------------------------------------------
// Atom dispatch + AND/OR composition
// ---------------------------------------------------------------------------

/** Tried in this fixed order: range and temporal are attempted before the numeric comparison (so `"between 100 and 500"` is never partially matched as `"... at 100"`-style noise), categorical last (only fires when nothing numeric/temporal matched). */
function parseAtom(text: string): StructuredCondition | undefined {
  return parseRangeAtom(text) ?? parseTemporalAtom(text) ?? parseComparisonAtom(text) ?? parseCategoricalAtom(text);
}

/** True when splitting `text` on every top-level "and" yields two or more parts that EACH independently parse as a non-categorical-recursion-triggering atom — i.e. `text` is really a conjunction, not a single field containing a literal "and". Deliberately excludes categorical from the per-part check would be circular to define away entirely; calling `parseAtom` (which does include categorical) here is safe because each part is always strictly shorter than `text`, so recursion terminates. */
function hasIndependentConjunctionSplit(text: string): boolean {
  const parts = splitOnConnective(text, 'and');
  if (!parts) return false;
  return parts.every((part) => parseAtom(part) !== undefined);
}

/**
 * Splits `text` on every top-level, word-boundary occurrence of
 * `connective` (`"and"` or `"or"`), returning the operand substrings.
 * Returns `undefined` (never partial) unless there are at least two
 * non-empty operands.
 */
function splitOnConnective(text: string, connective: 'and' | 'or'): readonly string[] | undefined {
  const lower = text.toLowerCase();
  const indices = allPhraseBoundaryIndices(lower, connective);
  if (indices.length === 0) return undefined;
  const parts: string[] = [];
  let cursor = 0;
  for (const idx of indices) {
    parts.push(text.slice(cursor, idx).trim());
    cursor = idx + connective.length;
  }
  parts.push(text.slice(cursor).trim());
  const nonEmpty = parts.filter((p) => p.length > 0);
  if (nonEmpty.length < 2 || nonEmpty.length !== parts.length) return undefined;
  return nonEmpty;
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
export function parseStructuredCondition(text: string): StructuredCondition | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  const whole = parseAtom(trimmed);
  if (whole) return whole;

  const lower = trimmed.toLowerCase();
  const hasAnd = allPhraseBoundaryIndices(lower, 'and').length > 0;
  const hasOr = allPhraseBoundaryIndices(maskOrContainingComparisonPhrases(lower), 'or').length > 0;
  if (hasAnd && hasOr) return undefined; // mixed precedence — refuse to guess

  if (hasAnd) {
    const parts = splitOnConnective(trimmed, 'and');
    if (!parts) return undefined;
    const operands = parts.map(parseAtom);
    if (operands.some((o) => o === undefined)) return undefined;
    return { type: 'and', operands: operands as StructuredCondition[] };
  }

  if (hasOr) {
    const parts = splitOnConnective(trimmed, 'or');
    if (!parts) return undefined;
    const operands = parts.map(parseAtom);
    if (operands.some((o) => o === undefined)) return undefined;
    return { type: 'or', operands: operands as StructuredCondition[] };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Action (verb + target)
// ---------------------------------------------------------------------------

/**
 * Closed action-verb vocabulary. A superset of `rule-pattern-parser.ts`'s
 * `DECISION_VERBS` (that list drives WHICH sentences become a `decision`
 * ReasoningNode in the first place — Phase 0/1, frozen, untouched here)
 * plus a few additional verbs that appear as a `rule`/`prerequisite`
 * node's `action` text (e.g. "apply a penalty fee") without themselves
 * being decision-classifying verbs. Recognizing more verbs here never
 * changes which ReasoningNode.nodeType a sentence gets — it only affects
 * whether this module can additionally structure the resulting action
 * text.
 */
const KNOWN_ACTION_VERBS = new Set([
  'approve',
  'approves',
  'reject',
  'rejects',
  'grant',
  'grants',
  'deny',
  'denies',
  'accept',
  'accepts',
  'decline',
  'declines',
  'apply',
  'applies',
  'waive',
  'waives',
  'escalate',
  'escalates',
  'refund',
  'refunds',
  'suspend',
  'suspends',
  'cancel',
  'cancels',
  'process',
  'processes',
  'require',
  'requires',
  'notify',
  'notifies',
]);

const LEADING_ARTICLES = new Set(['a', 'an', 'the']);

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
export function parseStructuredAction(text: string): StructuredAction | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const match = /^([A-Za-z]+)\b(.*)$/.exec(trimmed);
  if (!match) return undefined;
  const verb = match[1]!.toLowerCase();
  if (!KNOWN_ACTION_VERBS.has(verb)) return undefined;
  const rest = match[2]!.trim();
  const target = stripTrailingPunct(rest);
  return target.length > 0 ? { type: 'action', action: verb, target } : { type: 'action', action: verb };
}

/** Convenience used by callers that don't care which shape the leading word implies — never used by this module itself, kept for `@xo/compiler`'s per-node-type dispatch table (`structured-semantics.ts`) rather than re-implemented there. */
export function normalizeLeadingArticle(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length > 0 && LEADING_ARTICLES.has(words[0]!.toLowerCase())) {
    return words.slice(1).join(' ');
  }
  return text.trim();
}