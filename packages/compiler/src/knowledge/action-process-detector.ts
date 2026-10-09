import { containsAnyPhrase, EXCEPTION_CUES, OBLIGATION_CUES, RIGHT_CUES } from '../semantic/lexical-cues.js';

/**
 * Stage 4 operational-content detection: recognizes a bare action or
 * process statement — content with no higher-confidence Stage 3
 * classification (see `rule-based-extractor.ts`'s call site: this only
 * ever runs on a unit whose semantic type already mapped to the generic
 * `concept` fallback, i.e. `general`/`clause` units that Stage 3's
 * `semantic-type-classifier.ts` found no definition/obligation/
 * exception/right/example cue in) but that is still operationally
 * meaningful: an instruction, a procedural step, or an explicit
 * multi-step sequence.
 *
 * Deliberately **shape-based, not vocabulary-based** — this module
 * contains no action-verb list (that is `capabilities/capability-lexicon.ts`'s
 * job, a distinct concern: "is this significant enough to be its own
 * invokable capability" is a different question from "is this sentence
 * operational in nature at all"). Detection here rests on closed-class
 * function words (determiners, pronouns, copulas/auxiliaries,
 * conjunctions, conditional subordinators) and explicit sequencing/
 * composition phrasing — the same "structural/rhetorical cue" category
 * `lexical-cues.ts` already uses for definition/obligation/exception/
 * right detection, applied to a new distinction rather than a new
 * technique.
 *
 * Precision over recall, matching this package's established posture
 * (see Stage 7's `rule-pattern-parser.ts` doc comment: "false negatives
 * preferred over false positives"). A sentence this module does not
 * recognize simply falls through to `concept`, exactly as it did before
 * this module existed — never a regression, only an additive gain.
 */

export type OperationalContentKind = 'action' | 'process';

/** Closed-class words that indicate the sentence has an explicit subject, is a question, or is otherwise declarative/descriptive rather than imperative — none of these are ever the first word of a genuine bare command ("Install the dependency.", "Verify the health endpoint."). Function words only, never open-class/domain vocabulary. */
const NON_IMPERATIVE_LEADING_WORDS = new Set([
  // determiners / articles
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'any', 'all', 'some', 'no', 'both', 'either', 'neither',
  // pronouns
  'it', 'he', 'she', 'they', 'we', 'i', 'you', 'him', 'her', 'them', 'us', 'this', 'there', 'here', 'who', 'what', 'which', 'whom', 'whose',
  // copula / auxiliary / modal verbs (declarative or conditional-inversion signals, e.g. "Should the amount exceed...")
  'is', 'are', 'was', 'were', 'be', 'being', 'been', 'am',
  'has', 'have', 'had',
  'will', 'shall', 'must', 'may', 'should', 'can', 'could', 'would', 'might', 'do', 'does', 'did',
  // coordinating / subordinating conjunctions and conditional subordinators
  'and', 'or', 'but', 'nor', 'yet', 'so',
  'if', 'when', 'unless', 'while', 'although', 'though', 'because', 'since', 'as', 'once', 'until', 'whenever', 'wherever', 'whereas',
  // numbers / list-marker artifacts occasionally left in unit content
  'one', 'two', 'three', 'four', 'five',
]);

/** Mid-sentence conditional subordinators — a leading-word check alone would miss "..., if the amount exceeds the threshold, escalate the case" (trailing/embedded conditional). Deliberately distinct from `EXCEPTION_CUES` (unless/except/notwithstanding), which Stage 3 already checks before a unit ever reaches `general`/`clause`. */
const EMBEDDED_CONDITIONAL_CUES = ['if ', 'when ', 'unless ', 'in case ', 'in the event'];

const PROCESS_COMPOSITION_CUES = ['consists of', 'consist of', 'comprises', 'comprise of', 'is composed of', 'are composed of', 'made up of'];

const SEQUENCE_MARKERS = ['first,', 'first ', 'second,', 'second ', 'third,', 'next,', 'next ', 'then,', 'then ', 'finally,', 'finally ', 'subsequently', 'afterward', 'afterwards', 'lastly'];

/** A narrower set than the leading-word list: true auxiliary/copula/modal verbs only (no determiners, pronouns, or conjunctions). Checked against the first few words of a sentence, not just the first, to catch passive/declarative constructions with a bare-noun subject and no article ("Business is generated via...", "Payment is processed by...") — the leading word alone ("Business", "Payment") is not a recognizable function word, but the copula immediately after it is an unambiguous declarative signal. */
const AUX_COPULA_WORDS = new Set(['is', 'are', 'was', 'were', 'be', 'being', 'been', 'am', 'has', 'have', 'had', 'will', 'shall', 'must', 'may', 'should', 'can', 'could', 'would', 'might', 'do', 'does', 'did']);

function firstWords(text: string, count: number): readonly string[] {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').toLowerCase())
    .filter((w) => w.length > 0);
}

/** True if the raw (un-lowercased) leading token is an all-uppercase acronym/initialism of two or more letters (e.g. "CRM", "TDS"). Acronyms are essentially never imperative-mood command verbs in English, so a sentence opening with one — "CRM manages policy booking...", "TDS is deducted..." — is declarative, describing the acronym's referent, not instructing an action. This is a shape signal (capitalization pattern), not a vocabulary lookup: no specific acronym is named anywhere in this module. */
function startsWithAcronym(text: string): boolean {
  const trimmed = text.trim();
  const match = trimmed.match(/^[A-Za-z][A-Za-z'-]*/);
  if (!match) return false;
  const raw = match[0]!;
  return raw.length >= 2 && raw === raw.toUpperCase() && raw !== raw.toLowerCase();
}
function firstWord(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[A-Za-z][A-Za-z'-]*/);
  return match ? match[0]!.toLowerCase() : '';
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

function countMatchingPhrases(text: string, phrases: readonly string[]): number {
  const lower = text.toLowerCase();
  return phrases.reduce((count, phrase) => (lower.includes(phrase) ? count + 1 : count), 0);
}

/**
 * True if `content` carries any lexical cue Stage 3's classifier would
 * already have promoted to a higher-confidence semantic type
 * (definition/obligation/exception/right) — a defensive re-check, since
 * this module only ever runs on units Stage 3 *did not* so classify, but
 * a unit can span more text than the single clause Stage 3's classifier
 * matched against, and a longer `general` unit could still contain one
 * of these cues later in its content.
 */
function hasHigherPrecedenceCue(content: string): boolean {
  return containsAnyPhrase(content, OBLIGATION_CUES) || containsAnyPhrase(content, EXCEPTION_CUES) || containsAnyPhrase(content, RIGHT_CUES);
}

function hasConditionalCue(content: string): boolean {
  const lower = content.toLowerCase();
  return EMBEDDED_CONDITIONAL_CUES.some((cue) => lower.includes(cue));
}

/**
 * Detects an explicit multi-step process/sequence construction:
 * composition phrasing ("consists of A, B, and C") or two or more
 * explicit sequencing markers ("first... then... finally..."). Checked
 * before {@link detectAction} at the call site, since composition
 * language about several steps is a `process`, not a single `action`,
 * even though it may also contain an action verb.
 */
function detectProcess(content: string): boolean {
  if (containsAnyPhrase(content, PROCESS_COMPOSITION_CUES)) return true;
  return countMatchingPhrases(content, SEQUENCE_MARKERS) >= 2;
}

/**
 * Detects a bare imperative-mood operational statement: no explicit
 * subject/copula framing, no conditional/obligation/exception/right
 * framing, and at least one word of content beyond the leading verb (a
 * bare "Verify." with nothing else is not classified — there is no
 * object/complement to make it operationally meaningful rather than a
 * fragment).
 *
 * Two declarative-sentence shapes are explicitly excluded even though
 * their leading word is not itself a recognized function word: a bare
 * acronym/initialism subject ("CRM manages policy booking...",
 * "TDS is deducted...") and an early auxiliary/copula ("Business is
 * generated via...") — both are unambiguous declarative signals, not
 * imperative ones, detected purely by capitalization shape and closed-
 * class word position (see `startsWithAcronym`/`AUX_COPULA_WORDS`
 * above), never by naming any specific acronym or subject.
 *
 * Known, accepted residual limitation (still favoring precision over
 * recall): a rare sentence with an implicit subject, a lowercase,
 * non-acronym noun/pronoun-like leading word, and a third-person-
 * singular verb with no nearby auxiliary (e.g. a contrived "Staff sends
 * a confirmation email.") is not distinguished from true imperative mood
 * by this check. This residual construction is far rarer in practice
 * than the acronym/copula cases above (most real declaratives either
 * name a proper-noun/acronym subject or use an auxiliary/modal), so it
 * is accepted rather than adding a verb-inflection lexicon, which would
 * reintroduce the vocabulary-based approach this module deliberately
 * avoids.
 */
function detectAction(content: string): boolean {
  const trimmed = content.trim();
  if (wordCount(trimmed) < 2) return false;
  const lead = firstWord(trimmed);
  if (lead.length === 0) return false;
  if (NON_IMPERATIVE_LEADING_WORDS.has(lead)) return false;
  if (startsWithAcronym(trimmed)) return false;
  if (firstWords(trimmed, 4).some((w) => AUX_COPULA_WORDS.has(w))) return false;
  return true;
}

/**
 * Returns the operational content kind for `content`, or `undefined` if
 * it does not confidently fit either shape — the caller (`rule-based-
 * extractor.ts`) leaves the unit as `concept` in that case, exactly as
 * it did before this detector existed.
 */
export function detectOperationalContent(content: string): OperationalContentKind | undefined {
  if (hasHigherPrecedenceCue(content) || hasConditionalCue(content)) return undefined;
  if (detectProcess(content)) return 'process';
  if (detectAction(content)) return 'action';
  return undefined;
}
