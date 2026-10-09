/**
 * Manual (non-regex) word/phrase-boundary matching, and quoted-term
 * detection for definitions — shallow lexical *cues* used only to
 * classify a block's semantic type (semantic-type-classifier.ts), never
 * to extract legal meaning from it. This is structural/rhetorical-cue
 * detection (the same category as Stage 2's list-marker detection), not
 * the semantic entity/knowledge extraction Stage 4-9 (via `@xo/ai-core`)
 * is responsible for.
 */

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
}

/** True if `phrase` (already lowercase) appears in `lowerText` (already lowercase) at a word boundary on both sides. */
function containsPhraseBoundary(lowerText: string, phrase: string): boolean {
  let fromIndex = 0;
  for (;;) {
    const idx = lowerText.indexOf(phrase, fromIndex);
    if (idx === -1) return false;
    const before = idx > 0 ? lowerText[idx - 1] : undefined;
    const after = idx + phrase.length < lowerText.length ? lowerText[idx + phrase.length] : undefined;
    if (!isWordChar(before) && !isWordChar(after)) return true;
    fromIndex = idx + 1;
  }
}

export function containsAnyPhrase(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((phrase) => containsPhraseBoundary(lower, phrase.toLowerCase()));
}

export function startsWithAnyPhrase(text: string, phrases: readonly string[]): boolean {
  const trimmedLower = text.trim().toLowerCase();
  return phrases.some((phrase) => trimmedLower.startsWith(phrase.toLowerCase()));
}

export const OBLIGATION_CUES = ['shall', 'must', 'is required to', 'are required to', 'agrees to', 'shall not', 'is obligated to'];
export const RIGHT_CUES = ['may', 'is entitled to', 'has the right to', 'reserves the right to'];
export const EXCEPTION_CUES = ['except', 'unless', 'notwithstanding', 'provided that', 'other than'];
export const EXAMPLE_CUES = ['for example', 'e.g.', 'such as', 'including but not limited to', 'including without limitation'];
export const DEFINITION_CUES = ['means', 'shall mean', 'refers to', 'is defined as'];

const QUOTE_CHARS = ['"', '\u201c', '\u201d', "'"];

/**
 * Detects a "defined term" pattern: a quoted phrase followed shortly
 * (within a short character window, to avoid false matches across an
 * unrelated later quote) by a definition cue word. Returns the quoted
 * term itself (without its quote marks) if found — used both for
 * classifying a block as `definition` and, in relationship-builder.ts,
 * for finding every other unit that later uses the same defined term.
 */
export function detectDefinedTerm(text: string): string | undefined {
  for (let i = 0; i < text.length; i += 1) {
    if (!QUOTE_CHARS.includes(text[i]!)) continue;
    const closeIdx = findClosingQuote(text, i);
    if (closeIdx === -1) continue;
    const term = text.slice(i + 1, closeIdx).trim();
    if (term.length === 0 || term.length > 80) continue;
    const window = text.slice(closeIdx + 1, closeIdx + 1 + 30).toLowerCase();
    if (DEFINITION_CUES.some((cue) => window.includes(cue))) {
      return term;
    }
  }
  return undefined;
}

function findClosingQuote(text: string, openIdx: number): number {
  for (let j = openIdx + 1; j < text.length; j += 1) {
    if (QUOTE_CHARS.includes(text[j]!)) return j;
  }
  return -1;
}
