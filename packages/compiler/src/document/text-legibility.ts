/**
 * Phase 0 ("Make Source Extraction Trustworthy"): general, structural
 * signals that a single whitespace-delimited token is a PDF/table
 * extraction artifact rather than real source content — never a
 * blacklist of specific strings. Every rule here is justified on its own
 * shape (character-class transitions, length, digit/letter adjacency),
 * the same way this package's other structural heuristics are (see
 * `block-classifier.ts`, `candidate-plausibility.ts`). Two independent
 * consumers share these primitives so the same definition of "suspicious"
 * is used both to compute a document's overall quality state
 * (`document-quality.ts`) and to reject individual capability candidates
 * built from suspicious text (`../capabilities/candidate-plausibility.ts`)
 * — one rule, two enforcement points, not two competing definitions.
 */

export type SuspiciousTokenKind = 'digit_letter_mash' | 'title_case_word_fusion' | 'pathological_length';

export interface SuspiciousTokenFinding {
  /** The token exactly as it appeared in the source text (surrounding punctuation stripped for classification, but reported here for provenance/debugging). */
  readonly token: string;
  readonly kind: SuspiciousTokenKind;
}

/**
 * A lowercase letter-run of at least two characters directly touching a
 * run of four or more digits, in either order, with no separator
 * between them (`and8827461093`, `9821invoice0001`). Deliberately
 * requires the *letter* side of the boundary to be lowercase: real
 * alphanumeric identifiers this package's own fixtures are full of
 * (policy numbers, UINs, GSTINs — e.g. `IRDAN158RP0019V02201920`,
 * `RA322234012`) are conventionally built from uppercase letter runs, so
 * constraining the match to lowercase avoids flagging genuine
 * identifiers while still catching the actual defect pattern: an
 * ordinary lowercase English word (a leftover table-cell label, a
 * connector word like "and") glued directly onto a number with no space
 * — the same shape as the real fixture's own `and9821631474` artifact.
 */
const DIGIT_LETTER_MASH_RE = /[a-z]{2,}\d{4,}|\d{4,}[a-z]{2,}/;

/**
 * Two (or more) Title-Case words concatenated with no separator —
 * `NameOpted`, `PlanOpted`, `ContactNoEmail` — the exact shape a missing
 * inter-column space produces when both column headers/labels are
 * themselves capitalized words. Requires at least two lowercase letters
 * after the first capital before the next capital, so short two-letter
 * transitions common in real proper nouns (`McDonald`, `O'Brien`-style
 * names) are not flagged — this is a structural check on run-length, not
 * a dictionary lookup, so it is necessarily approximate, but the
 * two-lowercase-letter floor removes the single most common source of
 * false positives without narrowing to any specific word list. A single
 * Title-Case word with no internal transition (`Sion`, `Building`,
 * `Region`) does *not* match this — that is ordinary capitalized prose,
 * not a fusion artifact, and is legitimate source content on its own;
 * see `candidate-plausibility.ts` for how *that* shape is handled
 * (rejected only when paired with command-snippet-style parentheses).
 */
const TITLE_CASE_WORD_FUSION_RE = /^[A-Z][a-z]{2,}[A-Z][a-zA-Z]*$/;

/** A single alphabetic "word" longer than this is far more likely to be several real words/numbers glued together by a layout-reconstruction defect than a genuine single English word — the longest ordinary English words top out well short of this. Only applied to purely alphabetic tokens; genuine long identifiers/URLs are usually alphanumeric or punctuated and are not what this rule is for. */
const PATHOLOGICAL_LENGTH_THRESHOLD = 28;

/** Strips leading/trailing punctuation (quotes, brackets, sentence punctuation) so classification looks at the word itself, not its surrounding prose punctuation — mirrors `capabilities/rule-based-extractor.ts#stripPunctuation`'s own convention, kept local here to avoid a cross-directory dependency for one small helper. */
function stripSurroundingPunctuation(raw: string): string {
  let start = 0;
  let end = raw.length;
  const isWordChar = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
  while (start < end && !isWordChar(raw[start]!)) start += 1;
  while (end > start && !isWordChar(raw[end - 1]!)) end -= 1;
  return raw.slice(start, end);
}

/**
 * Classifies one already-whitespace-delimited token. Returns `undefined`
 * for anything that doesn't match a known artifact shape — the default,
 * and by far the common, outcome for ordinary source text. Never throws,
 * never needs any external dictionary/corpus (Phase 0 must remain fully
 * deterministic and offline).
 */
export function classifySuspiciousToken(rawToken: string): SuspiciousTokenKind | undefined {
  const token = stripSurroundingPunctuation(rawToken);
  if (token.length === 0) return undefined;

  if (DIGIT_LETTER_MASH_RE.test(token)) return 'digit_letter_mash';
  if (TITLE_CASE_WORD_FUSION_RE.test(token)) return 'title_case_word_fusion';
  if (token.length > PATHOLOGICAL_LENGTH_THRESHOLD && /^[A-Za-z]+$/.test(token)) return 'pathological_length';
  return undefined;
}

/** Splits `text` on whitespace and classifies every token, returning only the ones that matched an artifact shape — in source order, duplicates included (a caller counting/weighting findings wants every occurrence, not a deduplicated set). */
export function findSuspiciousTokens(text: string): readonly SuspiciousTokenFinding[] {
  const findings: SuspiciousTokenFinding[] = [];
  for (const rawToken of text.split(/\s+/)) {
    if (rawToken.length === 0) continue;
    const kind = classifySuspiciousToken(rawToken);
    if (kind !== undefined) findings.push({ token: rawToken, kind });
  }
  return findings;
}
