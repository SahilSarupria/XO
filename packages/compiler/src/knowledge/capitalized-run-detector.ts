export interface CapitalizedRun {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly wordCount: number;
}

interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function tokenize(text: string): readonly Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    while (i < text.length && isSpace(text[i]!)) i += 1;
    const start = i;
    while (i < text.length && !isSpace(text[i]!)) i += 1;
    if (i > start) tokens.push({ text: text.slice(start, i), start, end: i });
  }
  return tokens;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z';
}
function isLetterOrConnectorPunct(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === "'" || ch === '-' || ch === '.';
}

/** A token counts as a "capitalized word" if it starts with an uppercase letter and every other character is a letter, apostrophe, hyphen, or period (so "O'Brien", "Wal-Mart", and "Inc." all count). Trailing punctuation like a sentence-ending comma/period immediately after a word is stripped before this check. */
function stripTrailingPunctuation(word: string): string {
  let end = word.length;
  while (end > 0 && !isLetterOrConnectorPunct(word[end - 1]!)) end -= 1;
  return word.slice(0, end);
}

function isCapitalizedWord(word: string): boolean {
  if (word.length === 0 || !isUpper(word[0]!)) return false;
  for (let i = 1; i < word.length; i += 1) {
    if (!isLetterOrConnectorPunct(word[i]!)) return false;
  }
  return true;
}

/** Small connector words allowed *inside* a capitalized run (never at its start or end) — e.g. "Bank of America", "State of Delaware". Deliberately excludes "and": unlike a preposition/article, "and" is at least as likely to separate two distinct listed proper nouns ("O'Brien and Wal-Mart") as to join one compound name, so absorbing it would create more false merges than it fixes. */
const CONNECTOR_WORDS = new Set(['of', 'the', 'for', '&']);

/**
 * Closed-class English function words (determiners, pronouns, copulas/
 * auxiliaries, conjunctions, subordinators) that are capitalized only
 * because they happen to open a sentence — never because they name a
 * proper noun. Checked *only* against a single-word run (see the
 * `wordCount === 1` guard at the call site below): a multi-word run
 * ("State Farm", "New York") is already strong proper-noun evidence on
 * its own (per this file's own doc comment on `detectCapitalizedRuns`),
 * so this list is deliberately never applied to multi-word runs — doing
 * so could wrongly reject a genuine compound name that happens to start
 * with one of these words. Function words only, never open-class/domain
 * vocabulary, mirroring this package's established closed-class-cue
 * style (see `lexical-cues.ts`'s cue-phrase lists). */
const SENTENCE_INITIAL_FUNCTION_WORDS = new Set([
  // determiners / articles
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'any', 'all', 'some', 'no', 'both', 'either', 'neither',
  // pronouns
  'it', 'he', 'she', 'they', 'we', 'i', 'you', 'him', 'her', 'them', 'us', 'there', 'here', 'who', 'what', 'which', 'whom', 'whose',
  // copula / auxiliary / modal verbs
  'is', 'are', 'was', 'were', 'be', 'being', 'been', 'am', 'has', 'have', 'had',
  'will', 'shall', 'must', 'may', 'should', 'can', 'could', 'would', 'might', 'do', 'does', 'did',
  // coordinating / subordinating conjunctions and conditional subordinators
  'and', 'or', 'but', 'nor', 'yet', 'so',
  'if', 'when', 'where', 'unless', 'while', 'although', 'though', 'because', 'since', 'as', 'once', 'until', 'whenever', 'wherever', 'whereas',
  // prepositions commonly opening a subordinate/introductory clause
  'upon', 'within', 'after', 'before', 'during', 'without',
]);

/**
 * Detects runs of consecutive Title-Case words as candidate proper-noun
 * entities — a classic, non-ML heuristic for spotting organization/
 * product/entity names in running text, done here with manual character
 * scanning rather than regex (this package's established style; see
 * Stage 2/3's parsers). A single capitalized word is a weaker signal
 * than a multi-word run — `rule-based-extractor.ts` scales confidence by
 * `wordCount` accordingly.
 */
export function detectCapitalizedRuns(text: string): readonly CapitalizedRun[] {
  const tokens = tokenize(text);
  const runs: CapitalizedRun[] = [];

  let i = 0;
  while (i < tokens.length) {
    const word = stripTrailingPunctuation(tokens[i]!.text);
    if (!isCapitalizedWord(word)) {
      i += 1;
      continue;
    }

    let j = i + 1;
    let lastCapitalizedIndex = i;
    while (j < tokens.length) {
      const nextWord = stripTrailingPunctuation(tokens[j]!.text);
      if (isCapitalizedWord(nextWord)) {
        lastCapitalizedIndex = j;
        j += 1;
      } else if (CONNECTOR_WORDS.has(tokens[j]!.text.toLowerCase()) && j + 1 < tokens.length && isCapitalizedWord(stripTrailingPunctuation(tokens[j + 1]!.text))) {
        j += 1; // absorb the connector, continue the run into the following capitalized word
      } else {
        break;
      }
    }

    const runTokens = tokens.slice(i, lastCapitalizedIndex + 1);
    const isSentenceInitialFunctionWord = runTokens.length === 1 && SENTENCE_INITIAL_FUNCTION_WORDS.has(word.toLowerCase());
    if (!isSentenceInitialFunctionWord) {
      const start = runTokens[0]!.start;
      const end = runTokens[runTokens.length - 1]!.end;
      runs.push({ text: text.slice(start, end), startOffset: start, endOffset: end, wordCount: runTokens.length });
    }

    i = lastCapitalizedIndex + 1;
  }

  return runs;
}
