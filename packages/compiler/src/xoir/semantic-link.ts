import { confidenceFromScore, type XoirConfidence } from '@xo/xoir';

/**
 * The deterministic evidence model behind `linkReferencedNodes`
 * (`reasoning-to-xoir.ts`). Two independently-justified tiers, in
 * strictly descending trust order — never a single blended score, so
 * *why* a given link exists is always one of exactly two, plainly
 * statable reasons:
 *
 * 1. **Exact label match** (`exact_label`) — this module's predecessor's
 *    entire rule, preserved verbatim: the referenced node's own label
 *    appears, case/whitespace-insensitive, as a literal substring of the
 *    reasoning node's condition/action/outcome text. Unscoped by
 *    document position deliberately — a verbatim, deliberate use of a
 *    capability's own name is strong evidence regardless of how far away
 *    in the document it occurs, and narrowing this existing,
 *    already-working rule risks a real regression for no proven benefit.
 *
 * 2. **Same-unit term overlap** (`same_unit_term_overlap`) — new. Requires
 *    BOTH conditions, never either alone:
 *      a. the two nodes' *first* source reference
 *         (`XoirSourceRef.experienceUnitId`) is the same value — i.e.
 *         they were extracted from the same document unit (same
 *         paragraph-or-section-scoped chunk; see `semantic/unit-builder.ts`).
 *         This is the single strongest deterministic proximity signal
 *         this compiler's provenance model already carries — reusing it
 *         rather than inventing a new position/distance metric.
 *      b. at least one *significant* (stopword-filtered, lightly
 *         stem-normalized) token appears in both texts, AND at least one
 *         of the shared tokens is not purely numeric — see `scoreLink`'s
 *         own doc comment for why a bare shared number (almost always
 *         clause/section numbering in real policy documents, not a
 *         domain quantity) is never, by itself, sufficient evidence,
 *         while a number corroborating an already-shared real word
 *         still counts and is still reported. Additionally, if exactly
 *         one significant token is shared, it must be candidate-unique
 *         (appear in at most one candidate node's text, per
 *         `candidateTermFrequency` — Problem B.1) — a lone token shared
 *         by several candidates cannot discriminate between them and is
 *         not sufficient alone, though two or more shared tokens remain
 *         sufficient regardless of each one's own frequency — compared
 *         against `LinkCandidate.sameUnitText` (falling back to `label`
 *         when absent; see that field's own doc comment for why a
 *         richer text pool is used here specifically, and only here).
 *    Neither condition alone is treated as sufficient (see the module
 *    doc comment on why "same document" alone, or "shares a common
 *    word" alone, both produce real false positives on real documents —
 *    exactly the `"Contact 24-Hour Call Centre"` /
 *    `"Claims above 5000 may be rejected"` and `"Policy"` /
 *    `"Policy Number"` cases the design brief calls out). Their
 *    conjunction is what makes this tier safe: two clauses that were
 *    extracted from the very same chunk of source text *and* literally
 *    share a content word are far more likely to be genuinely about the
 *    same thing than either fact alone would suggest.
 *
 * Anything satisfying neither tier is **insufficient evidence** — no
 * link, full stop. This module never produces a third, weaker,
 * whole-document token-overlap tier; the design brief is explicit that
 * avoiding false links matters more than maximizing link count, and
 * whole-document overlap on a handful of generic domain words (exactly
 * what a real policy document is thick with — "claim," "policy,"
 * "insured") is precisely the failure mode that would reintroduce.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'if', 'then', 'that', 'this', 'these', 'those', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'will', 'shall', 'may', 'must', 'not', 'with', 'as', 'by', 'at', 'from', 'it', 'its',
  'any', 'all', 'no', 'such', 'per', 'within', 'upon', 'under', 'into', 'onto', 'so', 'than', 'also', 'each', 'other',
]);

/** Minimum token length to be considered at all — below this, near-every short function word/fragment survives stopword filtering only by accident. Does not apply to purely-numeric tokens (a short but specific number, e.g. `"14"` days or a `"60"`-day window, is still strong, unambiguous domain evidence — see `stem`'s own doc comment on why numbers are never stemmed away either). */
const MIN_TOKEN_LENGTH = 3;

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
function isAlpha(ch: string): boolean {
  const lower = ch.toLowerCase();
  return lower >= 'a' && lower <= 'z';
}

function splitIntoWords(text: string): readonly string[] {
  const words: string[] = [];
  let current = '';
  for (const ch of text.toLowerCase()) {
    if (isAlpha(ch) || isDigit(ch)) current += ch;
    else if (current.length > 0) {
      words.push(current);
      current = '';
    }
  }
  if (current.length > 0) words.push(current);
  return words;
}

/**
 * A deliberately minimal, conservative suffix-stripper — not a real
 * linguistic stemmer (no such dependency exists in this repository, and
 * this task does not warrant adding one). It exists to unify exactly the
 * handful of surface-form variations real policy prose actually uses
 * across a capability's own name and a nearby rule's wording (`"claim"`
 * / `"claims"` / `"claimed"`), never to aggressively conflate unrelated
 * words. A purely-numeric token is returned unchanged — a shared,
 * specific number (`"5000"`) is strong, unambiguous domain evidence in
 * its own right and must never be stemmed away.
 */
function stem(word: string): string {
  if (word.length === 0 || isDigit(word[0]!)) return word;
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('sses') || word.endsWith('xes'))) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** The set of significant, stemmed tokens in `text` — stopwords and sub-`MIN_TOKEN_LENGTH` fragments removed, everything else lowercased and lightly stemmed. Deterministic and order-independent (returned as a `Set`, since only membership/overlap ever matters downstream). */
export function significantTokens(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const word of splitIntoWords(text)) {
    const isNumeric = word.length > 0 && isDigit(word[0]!);
    if (!isNumeric && word.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(word)) continue;
    tokens.add(stem(word));
  }
  return tokens;
}

function sharedTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): readonly string[] {
  const shared: string[] = [];
  for (const token of a) {
    if (b.has(token)) shared.push(token);
  }
  return shared.sort();
}

function collapseWhitespace(text: string): string {
  let out = '';
  let lastWasSpace = false;
  for (const ch of text.trim()) {
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    if (isSpace) {
      if (!lastWasSpace) out += ' ';
      lastWasSpace = true;
    } else {
      out += ch;
      lastWasSpace = false;
    }
  }
  return out;
}

export type LinkEvidenceKind = 'exact_label' | 'same_unit_term_overlap' | 'structural_containment';

export interface LinkEvidence {
  readonly kind: LinkEvidenceKind;
  /** The referenced node's own label, verbatim — present only for `exact_label`. */
  readonly matchedLabel?: string;
  /** The shared significant, stemmed tokens — present for `same_unit_term_overlap`, and for `structural_containment` (its lexical-corroboration evidence, same token semantics), sorted for determinism. */
  readonly sharedTerms?: readonly string[];
  /**
   * Present only for `structural_containment` — how many heading levels
   * separate the reasoning node from its governing capability
   * (`reasoningSectionPath.length - capabilitySectionPath.length`). Small,
   * additive explainability metadata; the full section paths themselves
   * are NOT duplicated here since both nodes already carry their own
   * `XoirSourceRef.sectionPath` in their own provenance — this is purely
   * "how far apart were they," not a second copy of "where were they."
   */
  readonly ancestorDepthGap?: number;
}

export interface LinkScore {
  readonly confidence: XoirConfidence;
  readonly evidence: LinkEvidence;
}

/**
 * `basis: 'observed'` — a verbatim textual occurrence is a directly
 * observed fact about the source, not an inference (see `ConfidenceBasis`
 * in `@xo/xoir`'s `confidence.ts`). `corroboration: 1` — one piece of
 * evidence (the substring match itself); this tier does not currently
 * combine with same-unit overlap even when both happen to hold (see the
 * module doc comment's "never a single blended score").
 */
function exactLabelConfidence(): XoirConfidence {
  return confidenceFromScore(0.9, { basis: 'observed', evidenceStrength: 'strong', corroboration: 1, calibrated: false });
}

/**
 * `basis: 'inferred'` — this tier's whole premise is that no verbatim
 * evidence exists; the link is inferred from two independent structural
 * facts (same unit, shared vocabulary), matching `ConfidenceBasis`'s
 * literal `'inferred'` value. `corroboration` is the shared-term count,
 * capped in its contribution to `evidenceStrength` the same way
 * `evidenceStrengthFromCorroboration` already buckets any other
 * corroboration count elsewhere in this codebase — reused, not
 * reinvented. Score scales mildly with shared-term count (more shared,
 * specific vocabulary is more evidence) but is capped well below the
 * exact-match tier's score — this tier must never be mistaken for
 * verbatim evidence downstream.
 */
function sameUnitOverlapConfidence(sharedTermCount: number): XoirConfidence {
  const score = Math.min(0.5 + 0.05 * sharedTermCount, 0.75);
  const evidenceStrength = sharedTermCount >= 3 ? 'moderate' : 'weak';
  return confidenceFromScore(score, { basis: 'inferred', evidenceStrength, corroboration: sharedTermCount, calibrated: false });
}

/**
 * Problem C — confidence for the `structural_containment` tier. A fixed
 * `0.4`, deliberately below `sameUnitOverlapConfidence`'s floor of
 * `0.55` (its 1-shared-term case): crossing a section-unit boundary on a
 * heading-nesting inference is a strictly weaker structural claim than
 * two texts already sharing a document unit, so this tier must never
 * out-rank same-unit evidence even in its best case. Deliberately a
 * fixed constant, not a formula scaled by shared-term count the way
 * `sameUnitOverlapConfidence` is — this tier's evidence is fundamentally
 * a conjunction of two independent facts (structural containment AND
 * lexical corroboration) that either both hold or the link doesn't
 * exist at all; there is no principled basis yet for treating 3 shared
 * corroborating tokens as meaningfully more trustworthy than 1 for a
 * *structural* inference the way more shared vocabulary plausibly is
 * for a *same-unit* one, so this deliberately does not attempt to
 * invent one. `corroboration: 1` for the same reason — the "one
 * conjunction," not a token count.
 */
function structuralContainmentConfidence(): XoirConfidence {
  return confidenceFromScore(0.4, { basis: 'inferred', evidenceStrength: 'weak', corroboration: 1, calibrated: false });
}

export interface LinkCandidate {
  readonly label: string;
  readonly experienceUnitId: string | undefined;
  /**
   * Optional wider text pool used ONLY by the same-unit-term-overlap tier
   * (never by exact-label matching — that tier keeps checking `label`
   * alone, unchanged, so every existing exact-match behavior is
   * preserved verbatim). Falls back to `label` when omitted, so every
   * existing caller that never sets this field is entirely unaffected.
   *
   * Exists because a node's own short `label` (a capability's `name`, in
   * particular) is frequently too terse to carry the domain vocabulary
   * that would legitimately corroborate a same-unit link — e.g. a
   * capability named merely `"Review Action"` (a generic, verb-derived
   * name) shares no token with a same-unit rule's condition text, even
   * though the capability's own `description` (its full originating
   * sentence, per `@xo/compiler`'s `rule-based-extractor.ts`) plainly
   * does. Since this signal is only ever consulted *after* the same-unit
   * gate already passed, widening the vocabulary pool considered here
   * does not weaken that gate or introduce a third, document-wide tier —
   * it only lets the existing, already-anchored tier see the same
   * evidence a person skimming that unit's own text would.
   */
  readonly sameUnitText?: string;
}

function isPurelyNumericToken(token: string): boolean {
  return token.length > 0 && token.split('').every(isDigit);
}

/**
 * Scores one (reasoning-node-text, referenceable-node) pair. Returns
 * `undefined` for insufficient evidence — the caller must not create an
 * edge in that case. See the module doc comment for the full tier
 * definitions; this function is a thin, deterministic dispatcher over
 * the two tier-scoring functions above, doing only the matching itself.
 *
 * Same-unit overlap additionally requires the shared set to contain at
 * least one token that is NOT purely numeric. This is not a ban on
 * numeric evidence — a genuinely shared, specific quantity (`"10000"`,
 * `"employees"` + `"10"`, `"7"` + `"percent"`) still corroborates a link
 * exactly as before, and every numeric token stays in the returned
 * `sharedTerms` regardless. What this rejects is a link whose *entire*
 * evidence is one or more bare small numbers with no supporting
 * vocabulary at all — in real policy documents this reliably fires on
 * clause/section numbering (a "7. Decision Rules" heading and its own
 * "7.1"/"7.6" sub-clauses trivially share the digit "7" purely because
 * of the document's own numbering scheme, not because the two clauses
 * are about the same thing) rather than any actual domain quantity. A
 * numbering artifact carries no more semantic identity than a page
 * number would; requiring it to be corroborated by at least one real
 * word is the same "two independent facts, not one" principle the
 * same-unit tier already applies at the document-unit level (see the
 * module doc comment) — just applied within `sharedTerms` itself, at
 * the one place both tokens actually exist and can be told apart.
 *
 * Problem B.1 — a SINGLE shared token (necessarily non-numeric, since a
 * lone numeric token is already rejected above) is additionally
 * insufficient on its own if `candidateTermFrequency` shows it appears
 * in 2 or more candidate nodes' text. A term shared by several
 * candidates cannot, by itself, tell you which one this reasoning text
 * is actually about — this is not a corpus-frequency percentage or a
 * TF-IDF-style weight, just the direct structural fact of whether the
 * word is capable of discriminating at all. Confirmed against a real
 * fixture: a rule mentioning only `"claim"` linked, with equal weak
 * confidence, to two entirely different capabilities that both happen
 * to mention `"claim"` — exactly the failure this guards against. Two OR
 * MORE shared tokens are exempt from this check and remain sufficient
 * exactly as before, regardless of how common any individual token is
 * (`"insurer"` + `"loss"`, both individually common, is still accepted)
 * — the co-occurrence of multiple terms is evidence in its own right,
 * distinct from any single token's own frequency, and this function
 * does not attempt to weigh that combination any more finely.
 * `candidateTermFrequency` defaults to empty, so a caller that doesn't
 * supply real candidate-pool data (e.g. most existing tests, which test
 * `scoreLink` as a pure pairwise function) sees every unknown term as
 * frequency `0` — i.e. always treated as unique — leaving every
 * previously-passing single-term case unaffected unless the caller
 * opts in with real frequency data.
 */
export function scoreLink(
  reasoningText: string,
  reasoningUnitId: string | undefined,
  candidate: LinkCandidate,
  candidateTermFrequency: ReadonlyMap<string, number> = new Map(),
): LinkScore | undefined {
  const haystack = collapseWhitespace(reasoningText.toLowerCase());
  const label = candidate.label.trim();
  if (label.length === 0) return undefined;

  if (haystack.includes(collapseWhitespace(label.toLowerCase()))) {
    return { confidence: exactLabelConfidence(), evidence: { kind: 'exact_label', matchedLabel: candidate.label } };
  }

  if (reasoningUnitId !== undefined && reasoningUnitId === candidate.experienceUnitId) {
    const sameUnitText = (candidate.sameUnitText ?? label).trim();
    const shared = sameUnitText.length > 0 ? sharedTokens(significantTokens(reasoningText), significantTokens(sameUnitText)) : [];
    const hasNonNumericEvidence = shared.some((token) => !isPurelyNumericToken(token));
    // A lone shared token (always non-numeric here, given the check
    // above) must be candidate-unique — shared by at most one candidate
    // — to stand as sole evidence. Two or more shared tokens are never
    // subject to this check, regardless of each token's own frequency.
    const soleTokenIsAmbiguous = shared.length === 1 && (candidateTermFrequency.get(shared[0]!) ?? 0) >= 2;
    if (shared.length > 0 && hasNonNumericEvidence && !soleTokenIsAmbiguous) {
      return { confidence: sameUnitOverlapConfidence(shared.length), evidence: { kind: 'same_unit_term_overlap', sharedTerms: shared } };
    }
  }

  return undefined;
}

// --- Problem C: structural containment + lexical corroboration --------------
//
// A DISTINCT evidence tier from the two above, deliberately not folded
// into `scoreLink` or `LinkCandidate`: same-unit evidence answers "do
// these two texts sit in the same document unit," which is a
// meaningless question across a heading boundary (see this module's
// top-level doc comment). Structural containment answers a different
// question — "is this reasoning node nested inside this capability's own
// section" — using `XoirSourceRef.sectionPath` (the full heading-text
// trail from the document root down to a node's own unit), which
// `scoreLink`'s two tiers never read at all. Reuses `significantTokens`/
// `sharedTokens`/`isPurelyNumericToken` from above — the same
// tokenization and numeric-exclusion rules, not a parallel
// reimplementation — but applies its own, independently-checked
// sufficiency rule (see `scoreStructuralLink`), never B.1's
// candidate-pool-frequency ambiguity gate: that gate is specifically
// about *how many other candidates a term could equally have matched*
// within the same-unit pool, a question that doesn't transfer to a
// structural relationship already narrowed down to one specific
// ancestor by heading nesting — see the Problem C investigation report
// for why reusing it here would reject structurally strong relationships
// for no principled reason.

export interface StructuralLinkCandidate {
  /**
   * The candidate capability's own heading trail (its `XoirSourceRef.sectionPath`).
   * Must have length > 1 to ever be eligible — see `scoreStructuralLink`'s
   * root-exclusion check. A length-0-or-1 path denotes the synthetic
   * document-title-level section, which is never a valid governing
   * ancestor: everything in the document is nested under it, so "shares
   * an ancestor with the document root" carries no discriminating
   * information at all (this is exactly the degenerate case the Problem C
   * investigation measured directly: on the clinical fixture, a
   * document-root capability would otherwise absorb all 21 reasoning
   * nodes in the document).
   */
  readonly sectionPath: readonly string[];
  /** Same "wider vocabulary pool" concept as `LinkCandidate.sameUnitText` — typically `name` + `description` for a capability. */
  readonly lexicalText: string;
}

/**
 * True when `prefix` is a STRICT, position-wise prefix of `full` — i.e.
 * `full` denotes a heading nested one-or-more levels inside `prefix`'s
 * section. `prefix.length === full.length` (identical section) is
 * deliberately NOT a match: that is same-unit territory, already
 * `scoreLink`'s job, not this one.
 */
export function isStrictSectionPathPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length >= full.length) return false;
  return prefix.every((segment, i) => segment === full[i]);
}

/**
 * Scores a single (reasoning-node-text, candidate-capability) pair for
 * the `structural_containment` tier. Returns `undefined` whenever ANY of
 * the following holds — every check is independent and all must pass:
 *
 *   1. `candidate.sectionPath` denotes the document-root/title level
 *      (length <= 1) — root exclusion, see `StructuralLinkCandidate`'s
 *      doc comment. No fallback: a root-level capability is simply never
 *      eligible, under any circumstance, in this first implementation.
 *   2. `candidate.sectionPath` is not a STRICT prefix of
 *      `reasoningSectionPath` — the reasoning node is not structurally
 *      nested inside the candidate's own section at all (covers sibling
 *      branches, unrelated sections, and same-unit pairs alike — all
 *      correctly rejected here, since none of them is "nested inside").
 *   3. No lexical corroboration: the candidate's own text and the
 *      reasoning text share zero significant tokens, OR their only
 *      shared token(s) are purely numeric. A bare shared number (a
 *      clause/section-numbering artifact — see Problem B) is exactly as
 *      untrustworthy for a structural inference as for a same-unit one;
 *      this reuses `isPurelyNumericToken`'s exact rule, not a
 *      relaxed variant of it.
 *
 * `sharedTerms` is still reported in the resulting evidence when the
 * link is accepted (useful for audit/debugging), but unlike
 * `same_unit_term_overlap`, its length never affects the returned
 * confidence — see `structuralContainmentConfidence`'s doc comment.
 */
export function scoreStructuralLink(reasoningText: string, reasoningSectionPath: readonly string[] | undefined, candidate: StructuralLinkCandidate): LinkScore | undefined {
  if (reasoningSectionPath === undefined || reasoningSectionPath.length === 0) return undefined;
  if (candidate.sectionPath.length <= 1) return undefined; // root exclusion — no fallback
  if (!isStrictSectionPathPrefix(candidate.sectionPath, reasoningSectionPath)) return undefined;

  const lexicalText = candidate.lexicalText.trim();
  if (lexicalText.length === 0) return undefined;
  const shared = sharedTokens(significantTokens(reasoningText), significantTokens(lexicalText));
  const hasNonNumericEvidence = shared.some((token) => !isPurelyNumericToken(token));
  if (shared.length === 0 || !hasNonNumericEvidence) return undefined;

  const ancestorDepthGap = reasoningSectionPath.length - candidate.sectionPath.length;
  return {
    confidence: structuralContainmentConfidence(),
    evidence: { kind: 'structural_containment', sharedTerms: shared, ancestorDepthGap },
  };
}
