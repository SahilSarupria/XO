import { ok, type Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { KnowledgeGraph, KnowledgeNode, KnowledgeProvenance } from '../knowledge/types.js';
import type { ExperienceUnit } from '../semantic/types.js';
import { CAPABILITY_VERBS, CATEGORY_TITLE_KEYWORDS, MODAL_WORDS, PASSIVE_AUX_WORDS } from './capability-lexicon.js';
import { detectCommandSnippets } from './command-snippet-detector.js';
import { isPlausibleCandidateName, isPlausibleCommandIdentifier } from './candidate-plausibility.js';
import { splitSentences } from './sentence-split.js';
import { UNKNOWN_SIGNATURE, type CapabilityCategory } from './types.js';
import type { CandidateCapability, CapabilityExtractionResult, CapabilityExtractor } from './extractor-types.js';

function stripPunctuation(word: string): string {
  let start = 0;
  let end = word.length;
  const isWordChar = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === "'" || ch === '-';
  while (start < end && !isWordChar(word[start]!)) start += 1;
  while (end > start && !isWordChar(word[end - 1]!)) end -= 1;
  return word.slice(start, end);
}

function splitWords(text: string): readonly string[] {
  return text.split(' ').filter((w) => w.length > 0);
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/**
 * Upper bound on how many words after the matched verb are considered for
 * a candidate's object phrase. Wider than the prior hardcoded 3-word
 * window (which truncated names like "Contact the complainant to",
 * "Determine whether there is" mid-phrase on real, non-synthetic prose)
 * but still bounded, so a name can't run away to the end of a long
 * sentence. Combined with `trimTrailingStopWords` below, which trims the
 * low-content words a fixed-length slice tends to end on.
 */
const MAX_OBJECT_WINDOW_WORDS = 6;

/**
 * Low-content words (articles, prepositions, conjunctions, auxiliary
 * verbs) that make a poor final word for a capability name — a fixed-
 * length word window will sometimes end mid-phrase on exactly one of
 * these ("...to", "...an", "...with the Superior", "...there is"). Trims
 * them off the end of an object-word slice, repeatedly, so the name ends
 * on its last real content word instead. Never trims down to zero words;
 * a name that's nothing but stop words falls back to "<Verb> Action"
 * (unchanged existing behavior for an empty object-word list).
 */
const TRAILING_STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'with', 'of', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'there', 'and', 'or', 'that', 'this', 'which', 'by', 'at', 'from', 'as']);

function trimTrailingStopWords(words: readonly string[]): readonly string[] {
  const out = [...words];
  while (out.length > 1 && TRAILING_STOP_WORDS.has(out[out.length - 1]!.toLowerCase())) {
    out.pop();
  }
  return out;
}

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

function findCapabilityVerb(words: readonly string[]): VerbMatch | undefined {
  for (let i = 0; i < words.length; i += 1) {
    const clean = stripPunctuation(words[i]!).toLowerCase();
    const category = CAPABILITY_VERBS[clean];
    if (category) {
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
    const precededByModalBareBe = i > 1 && stripPunctuation(words[i - 1]!).toLowerCase() === 'be' && MODAL_WORDS.has(stripPunctuation(words[i - 2]!).toLowerCase());
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
      const looksLikeReducedRelativeClause = followingWordForEd !== undefined && ((followingWordForEd.length >= 3 && followingWordForEd.endsWith('ly')) || REDUCED_RELATIVE_PREPOSITIONS.has(followingWordForEd));
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
      const looksLikeNounPhrase = (precedingWord !== undefined && DETERMINER_WORDS.has(precedingWord)) || (followingWord !== undefined && AUX_FOLLOWER_WORDS.has(followingWord));
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
  return undefined;
}

function baseProvenance(unit: ExperienceUnit, confidence: number, charOffsetRange: readonly [number, number] | undefined): KnowledgeProvenance {
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
function findMentionedKnowledgeNodes(text: string, unit: ExperienceUnit, knowledgeGraph: KnowledgeGraph): { readonly nodeIds: readonly string[]; readonly conceptLabels: readonly string[] } {
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
      const words = splitWords(sentence.text);
      const match = findCapabilityVerb(words);
      if (!match) continue;

      const rawObjectWords = words
        .slice(match.wordIndex + 1, match.wordIndex + 1 + MAX_OBJECT_WINDOW_WORDS)
        .map(stripPunctuation)
        .filter((w) => w.length > 0);
      const objectWords = trimTrailingStopWords(rawObjectWords);
      const name = objectWords.length > 0 ? `${capitalize(match.verb)} ${objectWords.join(' ')}` : `${capitalize(match.verb)} Action`;
      if (!isPlausibleCandidateName(name)) {
        localIndex += 1;
        continue;
      }
      const confidence = match.wordIndex === 0 ? 0.6 : match.precededByModal ? 0.55 : match.isPassive ? 0.5 : 0.45;
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
        metadata: {},
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
      if (titleCategory && isPlausibleCandidateName(unit.headingTitle)) {
        const { nodeIds, conceptLabels } = findMentionedKnowledgeNodes(unit.content, unit, knowledgeGraph);
        capabilities.push({
          localId: 'title',
          category: titleCategory,
          name: unit.headingTitle,
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
