export interface Sentence {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Words that legitimately end in `.` without ending the sentence (an
 * abbreviation, not a sentence-final period) — checked case-insensitively
 * against the word immediately preceding a candidate `.`+whitespace
 * boundary. Kept deliberately minimal (not a general abbreviation
 * parser): "vs." is the one this package's own real-world fixtures rely
 * on splitting correctly (e.g. "Reconcile invoice amounts vs. receipt
 * amounts" must stay one sentence) — see `benchmark/CHANGELOG.md`'s
 * Layer 1B entry. Extending this set is additive, not a redesign, the
 * same convention `capability-lexicon.ts`'s lookup tables use.
 */
const SENTENCE_ABBREVIATIONS = new Set(['vs']);

const SENTENCE_END_CHARS = new Set(['.', '!', '?']);

/**
 * Whether the word immediately preceding `periodIndex` (a `.` in `text`)
 * is a known abbreviation (see `SENTENCE_ABBREVIATIONS`) — meaning that
 * `.` is not a genuine sentence-ending period.
 */
function precedingWordIsAbbreviation(text: string, periodIndex: number): boolean {
  let wordStart = periodIndex;
  while (wordStart > 0 && text[wordStart - 1] !== ' ' && text[wordStart - 1] !== '\n' && text[wordStart - 1] !== '\t' && text[wordStart - 1] !== '\r') {
    wordStart -= 1;
  }
  const word = text.slice(wordStart, periodIndex).toLowerCase();
  return SENTENCE_ABBREVIATIONS.has(word);
}

/**
 * Splits text into sentences by manual scanning (no regex, this
 * package's established style): a sentence ends at `.`/`!`/`?` followed
 * by whitespace (or end of string) — a deliberately simple rule that
 * doesn't special-case most abbreviations ("e.g.", "Mr.") or decimal
 * numbers, so those occasionally split into extra, shorter "sentences".
 * Harmless for this stage's purpose (each fragment is still scanned
 * independently for a capability verb), and documented rather than
 * silently assumed accurate. The one deliberate exception is `.` after a
 * known abbreviation (`SENTENCE_ABBREVIATIONS`, checked via
 * `precedingWordIsAbbreviation`) — narrowly targeted, not a general
 * abbreviation parser; see that set's doc comment.
 */
export function splitSentences(text: string): readonly Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    if (SENTENCE_END_CHARS.has(text[i]!)) {
      if (text[i] === '.' && precedingWordIsAbbreviation(text, i)) {
        i += 1;
        continue;
      }
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\n' || next === '\t' || next === '\r') {
        const raw = text.slice(start, i + 1);
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          const leadingTrim = raw.length - raw.trimStart().length;
          sentences.push({ text: trimmed, startOffset: start + leadingTrim, endOffset: start + leadingTrim + trimmed.length });
        }
        start = i + 1;
      }
    }
    i += 1;
  }
  if (start < text.length) {
    const raw = text.slice(start);
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const leadingTrim = raw.length - raw.trimStart().length;
      sentences.push({ text: trimmed, startOffset: start + leadingTrim, endOffset: start + leadingTrim + trimmed.length });
    }
  }
  return sentences;
}
