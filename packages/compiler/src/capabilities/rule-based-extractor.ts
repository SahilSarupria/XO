import { isNegatedAt } from './negation.js';
import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { KnowledgeGraph, KnowledgeNode, KnowledgeProvenance } from '../knowledge/types.js';
import type { ExperienceUnit } from '../semantic/types.js';
import { CAPABILITY_VERBS, CATEGORY_TITLE_KEYWORDS, MODAL_WORDS, PASSIVE_AUX_WORDS } from './capability-lexicon.js';
import { detectCommandSnippets } from './command-snippet-detector.js';
import { isPlausibleCandidateName, isPlausibleCommandIdentifier } from './candidate-plausibility.js';
import { splitSentences } from './sentence-split.js';
import { nameFromClause, nameFromPassive } from './clause.js';
import { assessCandidateQuality, qualityMetadata } from './quality.js';
import { cleanHeading } from '../semantic/structure.js';
import { imperativeClause, isQuestion } from '../semantic/directive.js';
import { isBaseVerb } from '../semantic/english-verbs.js';
import { UNKNOWN_SIGNATURE, type CapabilityCategory } from './types.js';
import type { CandidateCapability, CapabilityExtractionResult, CapabilityExtractor } from './extractor-types.js';

function stripPunctuation(word: string): string {
  let start = 0;
  let end = word.length;
  const isWordChar = (ch: string): boolean =>
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === "'" || ch === '-';
  while (start < end && !isWordChar(word[start]!)) start += 1;
  while (end > start && !isWordChar(word[end - 1]!)) end -= 1;
  return word.slice(start, end);
}

function splitWords(text: string): readonly string[] {
  return text.split(' ').filter((w) => w.length > 0);
}

// UW-3b: the fixed six-word object window and its trailing-stop-word trim were replaced by clause-bounded naming
// (`clause.ts`), which also bounds the name at six object words.

interface VerbMatch {
  readonly verb: string;
  readonly category: CapabilityCategory;
  readonly wordIndex: number;
  readonly precededByModal: boolean;
  readonly isPassive: boolean;
}

/**
 * Deterministically derives candidate base-verb forms for a regular past
 * participle ("created", "mapped", "generated", "reviewed") so a passive
 * clause ("invoices are created") can be matched against
 * `CAPABILITY_VERBS`'s base-form-only entries, without adding general
 * stemming to the lexicon lookup itself (see `PASSIVE_AUX_WORDS`'s doc
 * comment in `capability-lexicon.ts`). Only ever called for a word
 * immediately following a passive auxiliary (`is`/`are`/`was`/`were`/
 * `being`), so an ordinary past-tense verb elsewhere in a sentence is
 * never affected. Irregular participles (e.g. "sent", "written") are not
 * covered — this is a narrow, regular-suffix transform, not a full
 * morphological analyzer.
 */
/**
 * Deterministically derives candidate base-verb forms for a regular past
 * participle/past-tense form ("created", "mapped", "generated",
 * "reviewed", "reconciled") — used both for a passive clause ("invoices
 * are created") and, since a regular "-ed" form is essentially never
 * itself a common English noun (unlike a "-s" form — see
 * `deriveSSuffixBaseVerbCandidates`), for an ordinary active past-tense
 * clause too ("the clerk reconciled the accounts"). Deliberately not a
 * general stemmer: only ever called on a word actually ending in "-ed".
 * Irregular participles (e.g. "sent", "written") are not covered — this
 * is a narrow, regular-suffix transform, not a full morphological
 * analyzer.
 */
function deriveEdSuffixBaseVerbCandidates(word: string): readonly string[] {
  if (!word.endsWith('ed') || word.length < 4) return [];
  const stem = word.slice(0, -2); // "created" -> "creat", "mapped" -> "mapp", "reviewed" -> "review"
  const candidates = [stem, `${stem}e`]; // "creat" (unused directly) + "create"
  const last = stem[stem.length - 1]!;
  const secondLast = stem[stem.length - 2];
  const isDoubledConsonant = secondLast !== undefined && last === secondLast && !'aeiou'.includes(last);
  if (isDoubledConsonant) candidates.push(stem.slice(0, -1)); // "mapp" -> "map"
  return candidates;
}

/**
 * Deterministically derives candidate base-verb forms for a regular
 * third-person-singular-present form ("generates", "reconciles",
 * "matches", "authenticates") — the active-voice counterpart to
 * `deriveEdSuffixBaseVerbCandidates`. Unlike "-ed", a "-s" form is
 * routinely also an ordinary plural noun ("records", "matches" — both
 * common nouns as well as verbs), so this alone is not sufficient
 * evidence; `findCapabilityVerb`'s two surrounding-context guards (not
 * preceded by a determiner, not followed by a copula/auxiliary) exist
 * specifically to keep this narrow. Handles the regular "-es" ending
 * after a sibilant (match**es**, reach**es**) as well as plain "-s".
 */
function deriveSSuffixBaseVerbCandidates(word: string): readonly string[] {
  if (word.length < 4 || !word.endsWith('s')) return [];
  const candidates: string[] = [];
  if (/[sxz]es$/.test(word) || /[cs]hes$/.test(word)) candidates.push(word.slice(0, -2)); // "matches" -> "match", "reaches" -> "reach"
  candidates.push(word.slice(0, -1)); // "generates" -> "generate", "records" -> "record"
  return candidates;
}

/** Words that, immediately before a candidate "-s" verb form, are strong evidence it's actually a plural noun ("the records", "these matches") rather than a third-person-singular verb — a real verb is essentially never immediately preceded by one of these. */
const DETERMINER_WORDS = new Set(['the', 'a', 'an', 'this', 'these', 'those', 'some', 'many', 'few', 'all', 'each', 'every', 'such']);

/** Auxiliary/copula words that, immediately after a candidate "-s" verb form, are strong evidence the candidate is actually a plural-noun subject ("records ARE stored", "matches WERE found") rather than a third-person-singular verb with its own object. */
const AUX_FOLLOWER_WORDS = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had']);

/** Prepositions that, immediately after a candidate active "-ed" verb form, are strong evidence it's a reduced relative clause (a participle modifying the preceding noun — "reports generated FROM the CRM", "data validated BY the auditor") rather than a genuine transitive main-clause verb, which takes its direct object — a noun phrase, never a bare preposition — immediately after it. See `findCapabilityVerb`'s active-past-tense branch. */
const REDUCED_RELATIVE_PREPOSITIONS = new Set(['by', 'from', 'via', 'through', 'of', 'without', 'with', 'using']);

const CONDITIONAL_OPENERS = new Set(['if', 'when', 'whenever', 'where', 'unless', 'provided', 'once']);
const SUBORDINATE_OPENERS = new Set([...CONDITIONAL_OPENERS, 'until', 'after', 'before', 'because', 'since', 'while', 'whether']);

/**
 * Whether `index` lies in the condition of a sentence that opens with a conditional ("If A, B, and C, the claim is
 * paid."): before "then" when there is one, otherwise before the last comma (the main clause follows it).
 */
function inConditionOfSentence(words: readonly string[], index: number): boolean {
  // The verb's own clause opens with a subordinator ("... must be denied unless a flood endorsement is recorded").
  for (let k = index - 1; k >= 0; k -= 1) {
    const w = words[k]!;
    if (/[,;:]$/.test(w)) break;
    if (SUBORDINATE_OPENERS.has(stripPunctuation(w).toLowerCase())) return true;
  }
  const lead = words.findIndex((w) => !/^\d+(?:\.\d+)*[.)]?$/.test(w));
  if (lead < 0 || !CONDITIONAL_OPENERS.has(stripPunctuation(words[lead]!).toLowerCase())) return false;
  const thenIndex = words.findIndex((w, k) => k > lead && stripPunctuation(w).toLowerCase() === 'then');
  if (thenIndex >= 0) return index < thenIndex;
  let lastComma = -1;
  for (let k = 0; k < words.length; k += 1) if (words[k]!.endsWith(',')) lastComma = k;
  return lastComma >= 0 && index <= lastComma;
}

const NOUN_DETERMINERS = new Set([
  ...DETERMINER_WORDS,
  'my',
  'your',
  'his',
  'her',
  'its',
  'our',
  'their',
  'any',
  'no',
  'another',
  'which',
  'whose',
]);

const POSITION_MODALS = new Set(['shall', 'must', 'will', 'may', 'should', 'can', 'could', 'would', 'might', 'cannot', 'please']);
const SUBJECT_PRONOUNS = new Set(['i', 'we', 'you', 'they', 'he', 'she', 'it']);
const PASS_THROUGH = new Set([
  'not',
  'never',
  'also',
  'then',
  'instead',
  'otherwise',
  'rather',
  'always',
  'first',
  'next',
  'finally',
  'now',
  'just',
  'simply',
  'only',
  'again',
  'still',
  'immediately',
  'promptly',
]);
const COORDINATING = new Set(['and', 'or', 'then', 'nor']);
/** Words after which "to" is a preposition, not an infinitive marker ("subject to review", "prior to approval"). */
const PREPOSITIONAL_TO = new Set([
  'subject',
  'according',
  'due',
  'prior',
  'pursuant',
  'relative',
  'compared',
  'contrary',
  'similar',
  'equal',
  'close',
  'next',
  'addition',
  'regard',
  'respect',
  'reference',
  'access',
  'changes',
  'amendments',
  'response',
  'reply',
  'attached',
  'applicable',
  'up',
  'down',
  'back',
  'listed',
]);

/**
 * UW-3c: is the word at `i` in a place a verb stands? A capability verb is read as a verb only where English puts one: at the
 * start of a sentence or clause (an instruction), after a modal or "please", after an infinitive "to", after a subject
 * pronoun, or coordinated with such a verb ("Review and approve"). Elsewhere the same word is a noun ("emergency contact
 * information", "your personal schedule", "coverage checks").
 */
export function inVerbPosition(words: readonly string[], i: number): boolean {
  if (i === 0) return true;
  const prevRaw = words[i - 1]!;
  if (/[,;:(—–]$/.test(prevRaw) || /^\d{1,3}[.)]$/.test(prevRaw) || !/[\p{L}\p{N}]/u.test(prevRaw)) return true;
  const prev = stripPunctuation(prevRaw).toLowerCase();
  if (POSITION_MODALS.has(prev) || SUBJECT_PRONOUNS.has(prev)) return true;
  // The outcome side of a decision line ("Case H: policy expired -> coverage review"): an action named as a noun there is
  // still the action the line calls for.
  for (let j = i - 1; j >= Math.max(0, i - 3); j--) if (/^(?:->|=>|→|⇒|—>)$/.test(words[j]!)) return true;
  if (prev === 'to') return i < 2 || !PREPOSITIONAL_TO.has(stripPunctuation(words[i - 2]!).toLowerCase());
  if (PASS_THROUGH.has(prev) || (prev.length > 4 && prev.endsWith('ly'))) return inVerbPosition(words, i - 1);
  if (COORDINATING.has(prev)) {
    for (let j = i - 2; j >= 0; j--) {
      const w = stripPunctuation(words[j]!).toLowerCase();
      // The first conjunct may be any verb in a verb position ("..., wait and retry").
      if ((CAPABILITY_VERBS[w] !== undefined || isBaseVerb(w)) && inVerbPosition(words, j)) return true;
    }
    return false;
  }
  return false;
}

function findCapabilityVerb(words: readonly string[]): VerbMatch | undefined {
  for (let i = 0; i < words.length; i += 1) {
    const clean = stripPunctuation(words[i]!).toLowerCase();
    const category = CAPABILITY_VERBS[clean];
    // UW-3b: a base form right after a determiner or possessive is a noun ("the Schedule specifies", "your plan"), not a
    // verb; the scan moves on. UW-3c: and a base form outside a verb position is a noun too ("emergency contact
    // information"), as is a word used as a label ("Contact: the account manager").
    const precededByDeterminer = i > 0 && NOUN_DETERMINERS.has(stripPunctuation(words[i - 1]!).toLowerCase());
    if (category && !precededByDeterminer && inVerbPosition(words, i) && !/:$/.test(words[i]!)) {
      const precededByModal = i > 0 && MODAL_WORDS.has(stripPunctuation(words[i - 1]!).toLowerCase());
      return { verb: clean, category, wordIndex: i, precededByModal, isPassive: false };
    }

    const precededByPassiveAux = i > 0 && PASSIVE_AUX_WORDS.has(stripPunctuation(words[i - 1]!).toLowerCase());
    // "must be recorded", "shall be configured" — a modal followed by the
    // bare infinitive "be" is just as genuinely passive as "is recorded";
    // PASSIVE_AUX_WORDS only covers conjugated forms (is/are/was/were),
    // not this bare-infinitive-after-modal pattern, so it's checked
    // separately here rather than added to that set (which is also
    // consulted elsewhere for plain, non-modal auxiliary detection).
    // Routing this through the same passive branch — rather than letting
    // it fall through to the active-past-tense branch below — matters:
    // the passive branch's `execution`-category exclusion must still
    // apply ("the system must be configured" is exactly the same kind of
    // pre-existing-state/warranty statement as "the system is
    // configured", not a workflow step, regardless of the modal).
    const precededByModalBareBe =
      i > 1 && stripPunctuation(words[i - 1]!).toLowerCase() === 'be' && MODAL_WORDS.has(stripPunctuation(words[i - 2]!).toLowerCase());
    const isPassiveContext = precededByPassiveAux || precededByModalBareBe;

    // Passive-voice fallback: "invoices are created" — `clean` itself isn't
    // in the lexicon (it's a participle, "created"), but if it directly
    // follows a passive auxiliary, try deriving its base-verb form and
    // matching that instead. Restricted to artifact-producing/-moving
    // categories (generation, retrieval, transformation, validation,
    // communication, extraction, analysis, classification, summarization,
    // translation, planning, reasoning) and deliberately excludes
    // `execution` — verified against real fixtures that passive phrasing
    // of an execution-category verb ("a smoke detector is installed", "the
    // server is configured") overwhelmingly describes a pre-existing
    // state/warranty rather than a workflow step, unlike passive phrasing
    // of a generation/transformation verb ("invoices are created", "data
    // is mapped"), which reliably still describes real produced output.
    // Active/imperative usage of an execution verb ("Install the device")
    // is entirely unaffected by this restriction.
    if (isPassiveContext) {
      for (const candidate of deriveEdSuffixBaseVerbCandidates(clean)) {
        const passiveCategory = CAPABILITY_VERBS[candidate];
        if (passiveCategory && passiveCategory !== 'execution') {
          return { verb: candidate, category: passiveCategory, wordIndex: i, precededByModal: false, isPassive: true };
        }
      }
    }

    // Active past-tense fallback: "the clerk reconciled the accounts" — an
    // explicit subject actively performing a completed action is strong
    // evidence on its own (unlike the passive case above, which can
    // describe a pre-existing state rather than an event), so this isn't
    // restricted by category and doesn't require the passive-aux guard —
    // it only applies when that guard did NOT already match this word (a
    // passive "is/are/was/were/being X-ed" or "must be X-ed" reading takes
    // priority; this covers the remaining, non-passive "-ed" occurrences).
    // Guarded against a reduced relative clause ("a document created solely
    // to exercise...", "reports generated from the CRM", "data validated
    // by the auditor") — every verb in this lexicon is transitive and
    // requires a direct object immediately after it (a noun phrase, not a
    // preposition or an adverb); a participle instead modifying the
    // preceding noun has no object of its own to give and is typically
    // followed directly by a preposition describing source/agent/instrument
    // ("generated FROM the CRM", "validated BY the auditor") or an adverb
    // describing why ("created SOLELY to exercise..."), so an immediately-
    // following preposition or "-ly" word is treated as evidence against a
    // genuine active-voice event.
    if (!isPassiveContext) {
      // A word immediately adjacent to a quotation mark (the raw token
      // itself starts or ends with `"`, before punctuation-stripping) is a
      // quoted label/title being cited verbatim ("the 'Policy Booked'
      // reports"), not a word being used in its ordinary grammatical role —
      // neither active-voice fallback below should read it as a verb.
      const rawWord = words[i]!;
      const isQuoteAdjacent = rawWord.startsWith('"') || rawWord.endsWith('"');

      // A past-tense ("-ed") word as the very first word of its sentence,
      // with no subject before it, is never a genuine imperative (unlike a
      // base-form verb in that position — "Reconcile the accounts." is a
      // normal instruction; "Reconciled the accounts." is not a
      // grammatical sentence at all in ordinary English prose). It's far
      // more likely to be a document-reconstruction artifact — a fragment
      // whose true preceding context (a subject, or the rest of the
      // sentence it's really the tail of) was lost or merged incorrectly
      // upstream — than a genuine reported event. Scoped to `i === 0`
      // specifically: this says nothing about "-ed" words later in a
      // sentence, which the reduced-relative-clause guards above already
      // cover.
      const isSentenceInitialPastTense = i === 0;

      const followingWordForEd = i + 1 < words.length ? stripPunctuation(words[i + 1]!).toLowerCase() : undefined;
      const looksLikeReducedRelativeClause =
        followingWordForEd !== undefined &&
        ((followingWordForEd.length >= 3 && followingWordForEd.endsWith('ly')) || REDUCED_RELATIVE_PREPOSITIONS.has(followingWordForEd));
      if (!looksLikeReducedRelativeClause && !isQuoteAdjacent && !isSentenceInitialPastTense) {
        for (const candidate of deriveEdSuffixBaseVerbCandidates(clean)) {
          const activeCategory = CAPABILITY_VERBS[candidate];
          if (activeCategory) {
            return { verb: candidate, category: activeCategory, wordIndex: i, precededByModal: false, isPassive: false };
          }
        }
      }

      // Active present-tense fallback: "the CRM generates a report" —
      // `clean` ("generates") isn't itself in the lexicon, only its base
      // form ("generate") is. A "-s" form is routinely also a plain plural
      // noun ("records", "matches"), so this requires both surrounding-
      // context guards below rather than firing on the suffix alone.
      const precedingWord = i > 0 ? stripPunctuation(words[i - 1]!).toLowerCase() : undefined;
      const followingWord = i + 1 < words.length ? stripPunctuation(words[i + 1]!).toLowerCase() : undefined;
      const looksLikeNounPhrase =
        (precedingWord !== undefined && DETERMINER_WORDS.has(precedingWord)) ||
        (followingWord !== undefined && AUX_FOLLOWER_WORDS.has(followingWord));
      if (!looksLikeNounPhrase && !isQuoteAdjacent) {
        for (const candidate of deriveSSuffixBaseVerbCandidates(clean)) {
          const presentCategory = CAPABILITY_VERBS[candidate];
          if (presentCategory) {
            return { verb: candidate, category: presentCategory, wordIndex: i, precededByModal: false, isPassive: false };
          }
        }
      }
    }
  }
  return imperativeLead(words);
}

/**
 * Verbs that open a sentence without asking for an action: they point at something ("Note that ...", "See section 4"),
 * soften ("Try to ..."), or are too general to name one ("Do", "Make sure", "Be").
 */
const NON_ACTION_LEADS = new Set([
  'note',
  'see',
  'refer',
  'let',
  'be',
  'have',
  'do',
  'go',
  'get',
  'try',
  'keep',
  'make',
  'feel',
  'remember',
  'thank',
  'welcome',
  'like',
  'want',
  'mean',
  'say',
  'know',
  'think',
  'click',
]);
const FINITE_AUX = new Set([
  'is',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'does',
  'do',
  'did',
  'will',
  'shall',
  'may',
  'can',
  'must',
  'should',
  'would',
  'could',
  'might',
]);
const PARTICLES = new Set([
  'up',
  'down',
  'in',
  'out',
  'off',
  'on',
  'back',
  'through',
  'over',
  'into',
  'onto',
  'to',
  'with',
  'for',
  'under',
  'at',
  'by',
  'from',
  'across',
  'around',
  'against',
  'of',
]);

/**
 * UW-3c: an instruction whose verb is outside the capability lexicon ("Update the charter when the team changes.",
 * "Designate a captain."). The lexicon stays narrow because it also finds verbs mid-sentence; here only the verb that
 * OPENS the sentence's main clause counts, so the sentence is an instruction by its grammar.
 */
function imperativeLead(words: readonly string[]): VerbMatch | undefined {
  const text = words.join(' ');
  // A conditional instruction ("If the amount exceeds 10000, then deny the claim.") is a rule: the reasoning layer reads it
  // and the rule-capability minter names its outcome. Read here too, it would be a second capability for the same rule.
  if (/^[\p{P}\p{S}\s]*(?:if|when|whenever|unless|where|once|in case|provided|should|in the event)\b/iu.test(text)) return undefined;
  const clause = imperativeClause(text);
  if (clause === undefined) return undefined;
  const clauseWords = clause.split(/\s+/).filter((w) => w.length > 0);
  const wordIndex = words.length - clauseWords.length;
  if (wordIndex < 0) return undefined;
  const verb = stripPunctuation(words[wordIndex]!).toLowerCase();
  if (verb.length === 0 || NON_ACTION_LEADS.has(verb) || !isBaseVerb(verb)) return undefined;
  // The sentence's own grammar must say "instruction": a finished sentence of a few words, no label ("Benchmark intent:
  // ..."), and a word after the verb that starts its object — not a number, not a finite verb ("Cover is ..."), and not a
  // preposition followed by a finite verb ("Cover under this policy does not extend ...": the first word was a noun).
  if (clauseWords.length < 3 || !/[.!]["')\]]*$/.test(text.trim())) return undefined;
  if (clauseWords.slice(0, 3).some((w) => w.endsWith(':'))) return undefined;
  const nextRaw = stripPunctuation(words[wordIndex + 1] ?? '');
  const next = nextRaw.toLowerCase();
  if (next.length === 0 || /^\d/.test(next) || FINITE_AUX.has(next)) return undefined;
  // A capitalised word after a verb outside the lexicon reads as a title-case label ("Limit Opted ...", "Damage Cover").
  if (/^\p{Lu}/u.test(nextRaw)) return undefined;
  if (PARTICLES.has(next) && clauseWords.slice(2).some((w) => FINITE_AUX.has(stripPunctuation(w).toLowerCase()))) return undefined;
  return { verb, category: CAPABILITY_VERBS[verb] ?? 'action', wordIndex, precededByModal: false, isPassive: false };
}

function baseProvenance(
  unit: ExperienceUnit,
  confidence: number,
  charOffsetRange: readonly [number, number] | undefined,
): KnowledgeProvenance {
  return {
    experienceUnitId: unit.id,
    documentPath: unit.provenance.documentPath,
    pages: unit.provenance.pages,
    sectionPath: unit.provenance.sectionPath,
    charOffsetRange,
    confidence,
  };
}

/**
 * Second, independently-sufficient evidence tier for `findMentionedKnowledgeNodes`,
 * alongside (never instead of) exact-label matching. Exists because Stage 3's
 * `semantic/title.ts#synthesizeTitle` truncates long unit titles to 8 words plus a
 * literal ellipsis before Stage 4's `RuleBasedKnowledgeExtractor` uses that title as
 * an `action`/`process` node's own `canonicalLabel` (`label: definedTerm ?? unit.title`)
 * — so the exact-substring check below can never find that node's label verbatim in the
 * originating sentence, even though the node was extracted from that exact sentence.
 *
 * The already-existing, already-authoritative structural fact that recovers this: both
 * the capability and the knowledge node were extracted from the SAME `ExperienceUnit`
 * (a capability's `provenance.experienceUnitId` — see `baseProvenance` below — is always
 * the enclosing `unit.id`, since `RuleBasedCapabilityExtractor.extract` runs per-unit; a
 * knowledge node's own same-unit membership is its `KnowledgeProvenance.experienceUnitId`,
 * exactly the field `xoir/semantic-link.ts`'s `same_unit_term_overlap` tier already treats
 * as this compiler's strongest deterministic proximity signal). No new provenance is
 * invented and no document/page proximity is used — only this existing field.
 *
 * Deliberately narrowed to `action`/`process` semantic types (never `concept`, `entity`,
 * `obligation`, etc.) so this does not become "same unit => link everything in it to
 * everything else": an `ExperienceUnit` normally contributes at most one such node (Stage
 * 4's single `'primary'` node, when `detectOperationalContent` fires — see
 * `knowledge/rule-based-extractor.ts`), so recovering it does not create a capability
 * explosion, only recovers the one already-real action/process relationship Stage 5 was
 * silently dropping.
 */
function isSameUnitActionOrProcessEvidence(node: KnowledgeNode, unit: ExperienceUnit): boolean {
  if (node.semanticType !== 'action' && node.semanticType !== 'process') return false;
  return node.provenance.some((p) => p.experienceUnitId === unit.id);
}

/** Finds every knowledge node whose canonical label appears verbatim in `text` (or, failing that, is an `action`/`process` node from the same `ExperienceUnit` — see `isSameUnitActionOrProcessEvidence`), split into concept-typed labels and everything else — the same content-mention technique `../knowledge/relationship-builder.ts` uses. */
function findMentionedKnowledgeNodes(
  text: string,
  unit: ExperienceUnit,
  knowledgeGraph: KnowledgeGraph,
): { readonly nodeIds: readonly string[]; readonly conceptLabels: readonly string[] } {
  const nodeIds: string[] = [];
  const conceptLabels: string[] = [];
  for (const node of knowledgeGraph.nodes) {
    if (node.canonicalLabel.length >= 3 && text.includes(node.canonicalLabel)) {
      nodeIds.push(node.id);
      if (node.semanticType === 'concept') conceptLabels.push(node.canonicalLabel);
      continue;
    }
    if (isSameUnitActionOrProcessEvidence(node, unit)) {
      nodeIds.push(node.id);
    }
  }
  return { nodeIds, conceptLabels };
}

/**
 * Always-available extractor: never calls a network, never fails.
 * Detects capability evidence three ways per unit:
 *
 * 1. **Verb-based**: each sentence is scanned for a capability-indicating
 *    verb (`capability-lexicon.ts`), whether truly imperative
 *    ("Send the notice...") or modal-obligation phrasing ("...shall
 *    notify the Client"). Confidence scales with how strong that signal
 *    is (true imperative > modal-preceded > verb found elsewhere).
 * 2. **Title-based**: the unit's own title is checked against a table of
 *    category-indicating keywords ("Review", "Process", "Analysis", ...)
 *    — a heading is often itself the strongest evidence a section
 *    describes a capability.
 * 3. **Command-snippet-based**: `command-snippet-detector.ts`'s
 *    identifier-then-parens scan surfaces anything that looks like an
 *    API call or command example, with its parenthesized arguments
 *    parsed into candidate `inputs`.
 *
 * Every candidate's `requiredKnowledgeNodeIds`/`relatedConcepts` are
 * populated by cross-referencing the matched text against
 * `knowledgeGraph` (Stage 4's own output — Stage 5 consuming Stage 4,
 * per the compiler spec).
 */
export class RuleBasedCapabilityExtractor implements CapabilityExtractor {
  readonly name = 'rule-based';

  async extract(unit: ExperienceUnit, knowledgeGraph: KnowledgeGraph): Promise<Result<CapabilityExtractionResult, XoError>> {
    const capabilities: CandidateCapability[] = [];
    let localIndex = 0;

    for (const sentence of splitSentences(unit.content)) {
      // UW-3c: a question asks for something; it is not an action ("During what hours can we schedule team meetings?").
      if (isQuestion(sentence.text)) continue;
      const words = splitWords(sentence.text);
      // A verb inside a prohibition ("Do not create a missing receipt") is the opposite of a capability, so it is
      // skipped and the scan continues past it: "…; instead notify the claimant" still yields "Notify". The
      // prohibition itself is kept elsewhere (see negation.ts / extractProhibitions) as a safety constraint.
      let match: ReturnType<typeof findCapabilityVerb>;
      let from = 0;
      for (;;) {
        const found = findCapabilityVerb(words.slice(from));
        match = found === undefined ? undefined : { ...found, wordIndex: found.wordIndex + from };
        if (match === undefined || !isNegatedAt(words, match.wordIndex)) break;
        from = match.wordIndex + 1;
        if (from >= words.length) {
          match = undefined;
          break;
        }
      }
      if (!match) continue;

      // UW-3b: the name is the verb and its object from ONE clause (clause.ts), never words past a comma that starts the
      // next instruction, a subordinate clause or another cell. A verb that acts on nothing ("Policy Schedule" read as
      // "Schedule") states no action, so it is not a capability; the old "<Verb> Action" placeholder is gone.
      // UW-3b: a passive inside the condition of a conditional sentence describes a state the condition tests ("If the
      // Policy is active, ..., the property is scheduled, and the loss is not excluded, the claim ..."), not an action.
      if (match.isPassive && inConditionOfSentence(words, match.wordIndex)) {
        localIndex += 1;
        continue;
      }
      const clause =
        (match.isPassive ? nameFromPassive(words, match.wordIndex, match.verb) : undefined) ??
        nameFromClause(words, match.wordIndex, match.verb);
      // An intransitive instruction ("..., wait and retry.") is an action without an object; a verb form trailing a noun
      // ("Policy Schedule") is not.
      const previous = match.wordIndex > 0 ? words[match.wordIndex - 1]! : undefined;
      const imperativePosition =
        previous === undefined || /[,;:]$/.test(previous) || ['and', 'or', 'then'].includes(stripPunctuation(previous).toLowerCase());
      if (clause.objectWords.length === 0 && clause.verbPhrase.split(' ').length === 1 && !imperativePosition) {
        localIndex += 1;
        continue;
      }
      const name = clause.name;
      if (!isPlausibleCandidateName(name)) {
        localIndex += 1;
        continue;
      }
      // UW-3b: the positional prior is kept and multiplied down by what can be seen about the text (quality.ts).
      const prior = match.wordIndex === 0 ? 0.6 : match.precededByModal ? 0.55 : match.isPassive ? 0.5 : 0.45;
      const quality = assessCandidateQuality({
        prior,
        sentence: sentence.text,
        words,
        verbIndex: match.wordIndex,
        clause,
        layoutSuspect: unit.layoutSuspect === true,
      });
      if (quality.reject) {
        localIndex += 1;
        continue;
      }
      const confidence = quality.confidence;
      const { nodeIds, conceptLabels } = findMentionedKnowledgeNodes(sentence.text, unit, knowledgeGraph);

      capabilities.push({
        localId: `verb-${localIndex}`,
        category: match.category,
        name,
        description: sentence.text,
        confidence,
        provenance: baseProvenance(unit, confidence, [sentence.startOffset, sentence.endOffset]),
        inputs: [],
        outputs: [],
        requiredKnowledgeNodeIds: nodeIds,
        relatedConcepts: conceptLabels,
        invocationHints: [],
        examples: [],
        signature: UNKNOWN_SIGNATURE,
        metadata: qualityMetadata(quality),
        sourceUnitId: unit.id,
      });
      localIndex += 1;
    }

    // Title/category-keyword capability evidence is only valid for a genuine authored
    // heading (e.g. "Brokerage Validation") — NOT for `unit.title`, which is identical in
    // shape whether it's a real heading or `synthesizeTitle`'s content-prefix stand-in for
    // a unit with none (every unit but a section's first). Gating on `headingTitle`
    // (`undefined` unless `title` was borrowed from `section.heading`, per
    // `unit-builder.ts`) is what tells "Brokerage Validation" apart from ordinary prose
    // like "Reconcile the invoice balance against actual receipts received." whose
    // synthesized title happens to contain the keyword "invoice" — see `ExperienceUnit`'s
    // doc comment. `unit.title === unit.headingTitle` whenever the latter is defined, so
    // this only narrows *which* units are eligible; it changes no other behavior.
    if (unit.headingTitle !== undefined) {
      const titleWords = splitWords(unit.headingTitle).map((w) => stripPunctuation(w).toLowerCase());
      const titleCategory = titleWords.map((w) => CATEGORY_TITLE_KEYWORDS[w]).find((c) => c !== undefined);
      // UW-3b: the author's section number is position, not name ("6. Claims Procedure" names "Claims Procedure").
      const headingName = cleanHeading(unit.headingTitle);
      if (titleCategory && headingName.length > 0 && isPlausibleCandidateName(headingName)) {
        const { nodeIds, conceptLabels } = findMentionedKnowledgeNodes(unit.content, unit, knowledgeGraph);
        capabilities.push({
          localId: 'title',
          category: titleCategory,
          name: headingName,
          description: unit.content.slice(0, 280),
          confidence: 0.65,
          provenance: baseProvenance(unit, 0.65, [0, unit.content.length]),
          inputs: [],
          outputs: [],
          requiredKnowledgeNodeIds: nodeIds,
          relatedConcepts: conceptLabels,
          invocationHints: [],
          examples: [],
          signature: UNKNOWN_SIGNATURE,
          metadata: {},
          sourceUnitId: unit.id,
        });
      }
    }

    let snippetIndex = 0;
    for (const snippet of detectCommandSnippets(unit.content)) {
      const parenStart = snippet.text.indexOf('(');
      const identifier = snippet.text.slice(0, parenStart);
      if (!isPlausibleCommandIdentifier(identifier) || !isPlausibleCandidateName(identifier)) {
        snippetIndex += 1;
        continue;
      }
      const argsText = snippet.text.slice(parenStart + 1, -1);
      const inputs = argsText
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      capabilities.push({
        localId: `snippet-${snippetIndex}`,
        category: 'execution',
        name: identifier,
        description: `Command-like usage found in source: ${snippet.text}`,
        confidence: 0.6,
        provenance: baseProvenance(unit, 0.6, [snippet.startOffset, snippet.endOffset]),
        inputs,
        outputs: [],
        requiredKnowledgeNodeIds: [],
        relatedConcepts: [],
        invocationHints: [snippet.text],
        examples: [snippet.text],
        signature: UNKNOWN_SIGNATURE,
        metadata: {},
        sourceUnitId: unit.id,
      });
      snippetIndex += 1;
    }

    return ok({ capabilities, edges: [] });
  }
}
