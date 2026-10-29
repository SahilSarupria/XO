import { parseStructuredCondition } from '@xo/capability-contract';
import type { ReasoningNodeType } from './types.js';

/**
 * Manual (non-regex) sentence-pattern matching for reasoning/decision
 * structures — same technique and conservatism as
 * `../semantic/lexical-cues.ts` and `../capabilities/capability-lexicon.ts`
 * (this package's established style: shallow, explicit, no regex, false
 * negatives preferred over false positives — Stage 7 §15's "False
 * positives are worse than missing ambiguous reasoning").
 *
 * This module is deliberately the ONLY place sentence text is
 * interpreted; `rule-based-extractor.ts` just calls `parseSentence` per
 * sentence and turns whatever it returns into candidates. Nothing here
 * touches provenance, confidence combination with corroboration, ids, or
 * XOIR — see `types.ts` for what a `ParsedReasoningCandidate` becomes.
 */

export interface ParsedReasoningCandidate {
  readonly nodeType: ReasoningNodeType;
  readonly canonicalLabel: string;
  readonly condition?: string;
  readonly action?: string;
  readonly outcome?: string;
  readonly rationale?: string;
  readonly exceptionConditions: readonly string[];
  /** Pattern-match confidence alone — never inflated by how many sources agree (that's `merge.ts`'s job, based on real corroboration count). */
  readonly confidence: number;
  /** Which pattern fired — surfaced in tests and `metadata.matchedPattern` so a false positive is traceable to the exact rule that caused it. */
  readonly matchedPattern: string;
  /** True for a candidate that exists only because a companion candidate referenced it (e.g. the `exception` node an inline UNLESS clause spins off) — `rule-based-extractor.ts` still emits it as a full node, this just documents provenance of *why* it exists for anyone reading extraction output. */
  readonly companionOf?: string;
}

export interface ParsedReasoningEdge {
  readonly type: 'overrides' | 'alternative_to';
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly confidence: number;
}

export interface ParseResult {
  readonly candidates: readonly ParsedReasoningCandidate[];
  readonly edges: readonly ParsedReasoningEdge[];
}

const EMPTY_RESULT: ParseResult = { candidates: [], edges: [] };

function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
}

/** Index of `phrase` in `lowerText` at a word boundary on both sides, or -1. Both arguments must already be lowercase. */
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

function stripLeadingPhrase(text: string, phrase: string): string {
  const lower = text.toLowerCase();
  if (lower.startsWith(phrase)) return text.slice(phrase.length).trimStart();
  return text;
}

function stripTrailingPeriod(text: string): string {
  const trimmed = text.trim();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1).trim() : trimmed;
}

function clean(text: string): string {
  return stripTrailingPeriod(text).trim();
}

/** First top-level comma (used to split condition/action, prerequisite/target, etc.) — deliberately the *first* comma only, since these patterns are single-clause-per-side by construction. */
function indexOfFirstComma(text: string): number {
  const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== ',') continue;
    if (isDigit(text[i - 1]) && isDigit(text[i + 1])) continue; // thousands separator inside a number (e.g. "10,000") — not a clause/action boundary
    return i;
  }
  return -1;
}

const DECISION_VERBS = [
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
];

function startsWithDecisionVerb(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return DECISION_VERBS.some((verb) => lower === verb || lower.startsWith(`${verb} `));
}

// --- Pattern: prerequisite ("Before A, B must be completed.") --------------

function parsePrerequisite(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  if (!lower.startsWith('before ')) return EMPTY_RESULT;
  const commaIdx = indexOfFirstComma(sentence);
  if (commaIdx === -1) return EMPTY_RESULT;

  const gatedAction = clean(sentence.slice('before '.length, commaIdx));
  let prerequisite = clean(sentence.slice(commaIdx + 1));
  // Strip a trailing "must be completed"/"must be done"/"is required" tail — the prerequisite's own
  // *content* is what matters for matching/labeling; the modal phrasing around it isn't semantic content.
  const prereqLower = prerequisite.toLowerCase();
  for (const tail of [' must be completed', ' must be done', ' is required', ' must occur', ' must happen']) {
    if (prereqLower.endsWith(tail)) {
      prerequisite = prerequisite.slice(0, prerequisite.length - tail.length).trim();
      break;
    }
  }
  if (gatedAction.length === 0 || prerequisite.length === 0) return EMPTY_RESULT;

  return {
    candidates: [
      {
        nodeType: 'prerequisite',
        canonicalLabel: `${prerequisite} => ${gatedAction}`,
        condition: prerequisite,
        action: gatedAction,
        exceptionConditions: [],
        confidence: 0.75,
        matchedPattern: 'prerequisite:before-comma',
      },
    ],
    edges: [],
  };
}

// --- Pattern: rule (IF/WHEN ... THEN ..., with UNLESS / OTHERWISE / decision-verb handling) ---

const CONDITION_CUES = ['if ', 'when '];

function splitOffUnless(text: string): { readonly clause: string; readonly exception: string | undefined } {
  const lower = text.toLowerCase();
  const idx = indexOfPhraseBoundary(lower, 'unless');
  if (idx === -1) return { clause: text, exception: undefined };
  return { clause: clean(text.slice(0, idx)), exception: clean(text.slice(idx + 'unless'.length)) };
}

function splitOffOtherwise(text: string): { readonly primary: string; readonly alternative: string | undefined } {
  const lower = text.toLowerCase();
  for (const marker of ['otherwise', 'else']) {
    const idx = indexOfPhraseBoundary(lower, marker);
    if (idx !== -1) {
      return { primary: clean(text.slice(0, idx)), alternative: clean(text.slice(idx + marker.length)) };
    }
  }
  return { primary: text, alternative: undefined };
}

function parseRule(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const cue = CONDITION_CUES.find((c) => lower.startsWith(c));
  if (!cue) return EMPTY_RESULT;

  const commaIdx = indexOfFirstComma(sentence);
  if (commaIdx === -1) return EMPTY_RESULT; // no comma separating condition from action — too ambiguous to split conservatively

  const condition = clean(sentence.slice(cue.length, commaIdx));
  let actionClause = stripLeadingPhrase(clean(sentence.slice(commaIdx + 1)), 'then ');
  if (condition.length === 0 || actionClause.length === 0) return EMPTY_RESULT;

  const { clause: actionAfterUnless, exception } = splitOffUnless(actionClause);
  actionClause = actionAfterUnless;
  const { primary, alternative } = splitOffOtherwise(actionClause);
  const action = clean(primary);
  if (action.length === 0) return EMPTY_RESULT;

  const isDecision = startsWithDecisionVerb(action);
  const primaryCandidate: ParsedReasoningCandidate = isDecision
    ? {
        nodeType: 'decision',
        canonicalLabel: `${condition} => ${action}`,
        condition,
        outcome: action,
        exceptionConditions: exception !== undefined ? [exception] : [],
        confidence: 0.8,
        matchedPattern: alternative !== undefined ? 'rule:if-then-else:decision' : 'rule:if-then:decision',
      }
    : {
        nodeType: 'rule',
        canonicalLabel: `${condition} => ${action}`,
        condition,
        action,
        exceptionConditions: exception !== undefined ? [exception] : [],
        confidence: 0.8,
        matchedPattern: alternative !== undefined ? 'rule:if-then-else' : 'rule:if-then',
      };

  const candidates: ParsedReasoningCandidate[] = [primaryCandidate];
  const edges: ParsedReasoningEdge[] = [];

  if (exception !== undefined) {
    const exceptionCandidate: ParsedReasoningCandidate = {
      nodeType: 'exception',
      canonicalLabel: `unless ${exception}`,
      condition: exception,
      exceptionConditions: [],
      confidence: 0.7,
      matchedPattern: 'rule:unless-exception',
      companionOf: primaryCandidate.canonicalLabel,
    };
    candidates.push(exceptionCandidate);
    edges.push({
      type: 'overrides',
      fromLabel: exceptionCandidate.canonicalLabel,
      toLabel: primaryCandidate.canonicalLabel,
      confidence: 0.7,
    });
  }

  if (alternative !== undefined && alternative.length > 0) {
    const altCandidate: ParsedReasoningCandidate = {
      nodeType: 'alternative',
      canonicalLabel: `else: ${alternative}`,
      action: alternative,
      exceptionConditions: [],
      confidence: 0.65,
      matchedPattern: 'rule:if-then-else:alternative',
      companionOf: primaryCandidate.canonicalLabel,
    };
    candidates.push(altCandidate);
    edges.push({
      type: 'alternative_to',
      fromLabel: primaryCandidate.canonicalLabel,
      toLabel: altCandidate.canonicalLabel,
      confidence: 0.65,
    });
  }

  return { candidates, edges };
}

// --- Pattern: subject-to prerequisite ("Subject to A, B.") -----------------
//
// Structurally identical to `parsePrerequisite`'s "Before A, B" shape (a
// condition that gates an action), just with a different leading cue —
// real evidence: `examples/vertical-test/burglary-policy.pdf`'s "This
// policy is subject to the standard policy wordings..." shows the phrase
// in the wild, and the synthetic fixture's "Subject to satisfactory proof
// of loss, the insurer will process the claim within 14 days." is the
// clean, sentence-initial form this pattern targets. Only the
// sentence-initial form is matched (mirroring `parsePrerequisite`'s own
// leading-cue-only conservatism) — a mid-sentence "is subject to" (as in
// the PDF sentence above) is descriptive cross-reference language, not a
// standalone conditional obligation, and is deliberately left unmatched
// rather than guessed at.

function parseSubjectTo(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  if (!lower.startsWith('subject to ')) return EMPTY_RESULT;
  const commaIdx = indexOfFirstComma(sentence);
  if (commaIdx === -1) return EMPTY_RESULT;

  const condition = clean(sentence.slice('subject to '.length, commaIdx));
  const action = clean(sentence.slice(commaIdx + 1));
  if (condition.length === 0 || action.length === 0) return EMPTY_RESULT;

  return {
    candidates: [
      {
        nodeType: 'prerequisite',
        canonicalLabel: `${condition} => ${action}`,
        condition,
        action,
        exceptionConditions: [],
        confidence: 0.75,
        matchedPattern: 'prerequisite:subject-to-comma',
      },
    ],
    edges: [],
  };
}

// --- Pattern: trailing conditional ("Action, if condition.") ---------------
//
// The mirror image of `parseRule`'s leading if/when form — real evidence:
// burglary-policy.pdf's "...the policy is not valid, if any of the
// information provided is incorrect." is a genuine rule whose condition
// clause trails the action instead of leading it. Matched conservatively:
// requires a comma immediately followed by "if " (never guessed from a
// bare "if" with no comma, same discipline as the leading form), and
// requires the condition clause to be at least two words so a short
// parenthetical aside ("if any", "if ever", "if inconsistently" praising
// prose) isn't misread as a real condition — this is a structural length
// check, not a blacklist of specific words.

function findCommaThenIf(lower: string): number {
  let from = 0;
  for (;;) {
    const idx = lower.indexOf(',', from);
    if (idx === -1) return -1;
    if (
      lower
        .slice(idx + 1)
        .trimStart()
        .startsWith('if ')
    )
      return idx;
    from = idx + 1;
  }
}

function parseTrailingConditional(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const commaIdx = findCommaThenIf(lower);
  if (commaIdx === -1) return EMPTY_RESULT;

  const action = clean(sentence.slice(0, commaIdx));
  const conditionRaw = stripLeadingPhrase(clean(sentence.slice(commaIdx + 1)), 'if ');
  const condition = clean(conditionRaw);
  if (action.length === 0 || condition.length === 0) return EMPTY_RESULT;
  if (condition.split(' ').filter((w) => w.length > 0).length < 2) return EMPTY_RESULT;

  const isDecision = startsWithDecisionVerb(action);
  return {
    candidates: [
      isDecision
        ? {
            nodeType: 'decision',
            canonicalLabel: `${condition} => ${action}`,
            condition,
            outcome: action,
            exceptionConditions: [],
            confidence: 0.7,
            matchedPattern: 'decision:trailing-if',
          }
        : {
            nodeType: 'rule',
            canonicalLabel: `${condition} => ${action}`,
            condition,
            action,
            exceptionConditions: [],
            confidence: 0.7,
            matchedPattern: 'rule:trailing-if',
          },
    ],
    edges: [],
  };
}

// --- Pattern: prohibition ("Cannot do X." / "Must not do X." / "Do not do X.") ---

const PROHIBITION_CUES = ['cannot ', 'must not ', 'do not ', 'shall not '];

function parseProhibition(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const cue = PROHIBITION_CUES.find((c) => lower.startsWith(c));
  if (!cue) return EMPTY_RESULT;
  const action = clean(sentence);
  if (action.length === 0) return EMPTY_RESULT;
  return {
    candidates: [
      {
        nodeType: 'prohibition',
        canonicalLabel: action,
        action,
        exceptionConditions: [],
        confidence: 0.75,
        matchedPattern: 'prohibition:leading-cue',
      },
    ],
    edges: [],
  };
}

// --- Pattern: passive exclusion ("X is excluded." / "X are not covered.") --
//
// Real evidence: burglary-policy.pdf's "Terrorism cover is excluded",
// "Theft and RSMD is Excluded", and the "...are  excluded from scope of
// cover under the policy" clauses; the synthetic fixture's "Flood damage
// is excluded." / "War and nuclear risk are not covered." are the clean
// form. This is the passive-voice counterpart to `PROHIBITION_CUES`'
// active-voice "cannot/must not/do not" — insurance- and policy-style
// documents overwhelmingly state exclusions in passive voice ("X is
// excluded") rather than as an imperative ("do not cover X"), which is
// exactly the kind of genuine, source-justified rule form Phase 1 targets
// (as opposed to a generic "add more verbs" regex). Matched anywhere the
// phrase appears at a word boundary, not just sentence-final, since real
// exclusion clauses are often followed by trailing qualifiers ("...are
// excluded from scope of cover under the policy").

const EXCLUSION_PHRASES = ['is excluded', 'are excluded', 'is not covered', 'are not covered'];

function parsePassiveExclusion(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const matched = EXCLUSION_PHRASES.find((phrase) => indexOfPhraseBoundary(lower, phrase) !== -1);
  if (!matched) return EMPTY_RESULT;
  const action = clean(sentence);
  if (action.length === 0) return EMPTY_RESULT;
  return {
    candidates: [
      {
        nodeType: 'prohibition',
        canonicalLabel: action,
        action,
        exceptionConditions: [],
        confidence: 0.7,
        matchedPattern: `prohibition:passive-exclusion`,
      },
    ],
    edges: [],
  };
}

// --- Normalised executable rules: threshold routing and day-based deadlines --------------------
//
// The two shapes that dominate insurance operating procedures and that the existing deterministic engine
// can already evaluate (`StructuredComparisonBindingResolver`: numeric comparison; "within N days of <field>"):
//
//   threshold  "Claims above 10000 must be referred to a senior adjuster for approval."
//              -> condition "the claim amount exceeds 10000", outcome "must be referred to ..."
//   deadline   "Claim documents must be submitted within 15 days after discharge from hospital."
//              -> condition "the days since discharge from hospital is at most 15"
//
// Each emits an ordinary `rule` candidate whose condition is re-validated by the SAME parser the runtime
// resolver uses (`parseStructuredCondition`); a sentence whose normalised condition does not parse is not
// emitted (falls through to the constraint patterns). The existing minter then gives a clean rule its own
// capability, so nothing here widens what the runtime can execute: it only lets common sentences reach the
// grammar that was already there. A deadline becomes a numeric comparison on "<unit> since <event>", supplied at run
// time as the elapsed count in that unit (days, working days, hours, months or years).

/** Money-bearing subjects whose bare "above N" means an amount ("Claims above 10000"). */
const AMOUNT_SUBJECTS: ReadonlySet<string> = new Set(['claim', 'loss', 'payment', 'settlement', 'invoice', 'payout', 'refund', 'premium']);

function singular(word: string): string {
  const w = word.toLowerCase();
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function normalisedRule(
  condition: string,
  outcome: string,
  matchedPattern: string,
  confidence: number,
  originalSentence: string,
): ParseResult {
  if (parseStructuredCondition(condition) === undefined) return EMPTY_RESULT;
  const text = clean(originalSentence);
  return {
    candidates: [
      {
        nodeType: 'rule',
        canonicalLabel: text,
        condition,
        action: outcome,
        rationale: text,
        exceptionConditions: [],
        confidence,
        matchedPattern,
      },
    ],
    edges: [],
  };
}

const THRESHOLD_ROUTING =
  /^(?<subject>[A-Za-z][A-Za-z -]{0,40}?)\s+(?:with (?:an? |the )?(?<field>[a-z][a-z ]{1,30}?)\s+)?(?:above|over|exceeding|greater than|more than)\s+(?<num>\d[\d,]*(?:\.\d+)?)(?<pct>%|\s?per ?cent)?(?:\s+of\s+(?:the\s+)?(?<base>[a-z][a-z ]{1,30}?))?\s+(?<rest>(?:must|shall|require|requires|are to|is to)\s+.+)$/i;
const THRESHOLD_UP_TO =
  /^(?:[A-Za-z][A-Za-z ]{0,30}?)\s+may\s+(?<verb>accept|approve|settle|pay|process)\s+(?<obj>[a-z][a-z ]{0,30}?)\s+with (?:an? |the )?(?<field>[a-z][a-z ]{1,30}?)\s+up to\s+(?<num>\d[\d,]*(?:\.\d+)?)\s+(?<rest>without\s+.+)$/i;

function parseThresholdRule(sentence: string): ParseResult {
  const text = clean(sentence);
  const up = THRESHOLD_UP_TO.exec(text);
  if (up?.groups) {
    const { verb, obj, field, num, rest } = up.groups as Record<string, string>;
    return normalisedRule(
      `the ${field!.trim().toLowerCase()} is at most ${num}`,
      `${verb} ${obj} ${rest}`,
      'rule:normalized-threshold-up-to',
      0.75,
      sentence,
    );
  }
  const m = THRESHOLD_ROUTING.exec(text);
  if (!m?.groups) return EMPTY_RESULT;
  const { subject, field, num, pct, base, rest } = m.groups as Record<string, string | undefined>;
  const head = singular(subject!.trim().split(/\s+/).pop()!);
  let fieldPhrase: string | undefined;
  if (field !== undefined) fieldPhrase = field.trim().toLowerCase();
  else if (pct !== undefined && base === undefined) fieldPhrase = `${head} percentage`;
  else if (AMOUNT_SUBJECTS.has(head)) fieldPhrase = `${head} amount`;
  if (fieldPhrase === undefined) return EMPTY_RESULT; // never guess what "above N" measures
  // "Claims exceeding 10% of the sum insured": one runtime input holding that percentage, named for what it is. The
  // engine has no ratio operator, so the caller supplies the already-computed percentage (like a deadline's elapsed count).
  if (pct !== undefined && base !== undefined && base.trim().split(/\s+/).length <= 4) {
    fieldPhrase = `${fieldPhrase} percentage of ${base.trim().toLowerCase()}`;
  } else if (base !== undefined) return EMPTY_RESULT;
  return normalisedRule(`the ${fieldPhrase} exceeds ${num}`, rest!.trim(), 'rule:normalized-threshold', 0.75, sentence);
}

const DEADLINE_UNIT = '(?:calendar days?|working days?|business days?|days?|hours?|months?|years?)';
const DEADLINE_RULE = new RegExp(
  `^(?<actor>[A-Za-z][A-Za-z -]{0,40}?)\\s+(?<modal>must|shall)\\s+(?<verb>(?!not\\b).+?)\\s+(?:within|no later than)\\s+(?<n>\\d+)\\s+(?<unit>${DEADLINE_UNIT})\\s+(?:of|after|from|following)\\s+(?<event>[a-z][a-z' -]{1,60})$`,
  'i',
);
const DEADLINE_RULE_LEADING = new RegExp(
  `^(?:within|no later than)\\s+(?<n>\\d+)\\s+(?<unit>${DEADLINE_UNIT})\\s+(?:of|after|from|following)\\s+(?<event>[a-z][a-z' -]{1,60}?),\\s+(?<actor>[A-Za-z][A-Za-z -]{0,40}?)\\s+(?<modal>must|shall)\\s+(?<verb>(?!not\\b).+)$`,
  'i',
);

/** "calendar days" and "days" are the same count; "business days" is "working days". Hours, working days, months and years keep their own unit so the input is named for what the caller must supply. */
function deadlineUnit(raw: string): string {
  const u = raw
    .toLowerCase()
    .replace(/^calendar /, '')
    .replace(/^business /, 'working ');
  return u.endsWith('s') ? u : `${u}s`;
}

function parseDeadlineRule(sentence: string): ParseResult {
  const text = clean(sentence);
  const m = DEADLINE_RULE.exec(text) ?? DEADLINE_RULE_LEADING.exec(text);
  if (!m?.groups) return EMPTY_RESULT;
  const { actor, modal, verb, n, unit, event } = m.groups as Record<string, string>;
  const eventPhrase = event!.trim().replace(/^the\s+/i, '');
  if (eventPhrase.split(/\s+/).length > 6) return EMPTY_RESULT; // too long to be a reference phrase
  // "the <unit> since <event> is at most N": a plain numeric comparison the runtime already evaluates, with the unit in
  // the input's own name ("working_days_since_discharge_hospital") so a caller cannot silently supply days for hours.
  return normalisedRule(
    `the ${deadlineUnit(unit!)} since ${eventPhrase} is at most ${n}`,
    `${actor!.trim()} ${modal!.toLowerCase()} ${verb!.trim()}`,
    'rule:normalized-deadline',
    0.75,
    sentence,
  );
}

// --- Pattern: warranty obligation ("Warranted that X." / "Warranted X.") ---
//
// Real evidence: burglary-policy.pdf's repeated "Warranted that ..."
// clauses (a standard insurance-warranty boilerplate structure) and the
// synthetic fixture's "Warranted that a working smoke detector is
// installed on every floor." A `Warranted` clause is a mandatory
// requirement the policyholder must satisfy — the same semantic role as
// `parsePolicy`'s "must "/"only ... may " obligations, just with its own
// distinct leading cue, so it reuses the `policy` node type (-> XOIR
// `constraint`) rather than inventing a new one.

const WARRANTY_CUES = ['warranted that ', 'warranted '];

function parseWarranty(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const cue = WARRANTY_CUES.find((c) => lower.startsWith(c));
  if (!cue) return EMPTY_RESULT;
  const action = clean(sentence.slice(cue.length));
  if (action.length === 0) return EMPTY_RESULT;
  return {
    candidates: [
      {
        nodeType: 'policy',
        canonicalLabel: action,
        action,
        exceptionConditions: [],
        confidence: 0.7,
        matchedPattern: cue.trim() === 'warranted that' ? 'policy:warranted-that' : 'policy:warranted',
      },
    ],
    edges: [],
  };
}

// --- Pattern: policy ("Only managers may approve Y." / "Must be over 18.") ---

function parsePolicy(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  if (lower.startsWith('only ') && indexOfPhraseBoundary(lower, 'may') !== -1) {
    const text = clean(sentence);
    return {
      candidates: [
        {
          nodeType: 'policy',
          canonicalLabel: text,
          action: text,
          exceptionConditions: [],
          confidence: 0.7,
          matchedPattern: 'policy:only-role-may',
        },
      ],
      edges: [],
    };
  }
  if (lower.startsWith('must ')) {
    const text = clean(sentence);
    return {
      candidates: [
        {
          nodeType: 'policy',
          canonicalLabel: text,
          action: text,
          exceptionConditions: [],
          confidence: 0.65,
          matchedPattern: 'policy:must-obligation',
        },
      ],
      edges: [],
    };
  }
  // M1.2 recall addition — the same obligation shape as the
  // sentence-initial "must" cue above, but with an explicit short
  // subject first ("The Insured must notify the Insurer of a loss
  // within 7 days...", real policy §4.1/§4.3/§4.4/§6.1/§6.2). Every one
  // of these was previously invisible to extraction entirely — zero
  // candidate, not merely a low-confidence one — despite being an
  // ordinary policy obligation the extractor already knows how to
  // represent (same `policy` node type, same downstream `constraint`
  // canonical kind as the sentence-initial form above; a constraint has
  // no decision-table outcome regardless of how the sentence was
  // phrased, so this can never itself become newly executable — it only
  // makes an already-supported obligation shape visible in provenance
  // and audit output). The subject is capped at 4 words specifically to
  // avoid misreading a "must" buried deep in an unrelated subordinate
  // clause as this sentence's real top-level obligation — a structural
  // guard, not a blacklist of subject words.
  const mustIdx = indexOfPhraseBoundary(lower, 'must');
  if (mustIdx > 0) {
    const subjectWords = sentence
      .slice(0, mustIdx)
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (subjectWords.length > 0 && subjectWords.length <= 4) {
      const text = clean(sentence.slice(mustIdx));
      if (text.length > 0) {
        return {
          candidates: [
            {
              nodeType: 'policy',
              canonicalLabel: text,
              action: text,
              exceptionConditions: [],
              confidence: 0.65,
              matchedPattern: 'policy:subject-must-obligation',
            },
          ],
          edges: [],
        };
      }
    }
  }
  return EMPTY_RESULT;
}

// --- Pattern: alternative ("Option A is preferred when condition X holds.") ---

function parseAlternative(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const idx = indexOfPhraseBoundary(lower, 'is preferred when');
  if (idx === -1) return EMPTY_RESULT;
  const option = clean(sentence.slice(0, idx));
  const condition = clean(sentence.slice(idx + 'is preferred when'.length));
  if (option.length === 0 || condition.length === 0) return EMPTY_RESULT;
  return {
    candidates: [
      {
        nodeType: 'alternative',
        canonicalLabel: `${option} (preferred when ${condition})`,
        outcome: option,
        condition,
        exceptionConditions: [],
        confidence: 0.7,
        matchedPattern: 'alternative:preferred-when',
      },
    ],
    edges: [],
  };
}

// --- Pattern: justification ("Because E, D." / "D, because E.") -----------

function parseJustification(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  if (lower.startsWith('because ')) {
    const commaIdx = indexOfFirstComma(sentence);
    if (commaIdx === -1) return EMPTY_RESULT;
    const rationale = clean(sentence.slice('because '.length, commaIdx));
    const outcome = clean(sentence.slice(commaIdx + 1));
    if (rationale.length === 0 || outcome.length === 0) return EMPTY_RESULT;
    return {
      candidates: [
        {
          nodeType: 'justification',
          canonicalLabel: `${rationale} => ${outcome}`,
          rationale,
          outcome,
          exceptionConditions: [],
          confidence: 0.75,
          matchedPattern: 'justification:because-leading',
        },
      ],
      edges: [],
    };
  }

  const idx = indexOfPhraseBoundary(lower, 'because');
  if (idx !== -1 && idx > 0) {
    const outcome = clean(sentence.slice(0, idx));
    const rationale = clean(sentence.slice(idx + 'because'.length));
    if (outcome.length === 0 || rationale.length === 0) return EMPTY_RESULT;
    return {
      candidates: [
        {
          nodeType: 'justification',
          canonicalLabel: `${rationale} => ${outcome}`,
          rationale,
          outcome,
          exceptionConditions: [],
          confidence: 0.75,
          matchedPattern: 'justification:because-trailing',
        },
      ],
      edges: [],
    };
  }

  return EMPTY_RESULT;
}

// --- Pattern: satisfies/does-not-satisfy requirement ("X received within N days ... satisfies the notification requirement.") ---

/**
 * M1.3 addition — a narrow, evidence-driven pattern for real policy
 * §8.1/§8.2's exact shape: a condition-bearing clause followed by
 * "satisfies"/"does not satisfy" and a named requirement, with no
 * "if"/"when"/"must"/etc. leading cue at all. Previously produced zero
 * candidates. Checked ahead of nothing else (see its low position in
 * `parseSentence`'s dispatch list) — "satisfies"/"does not satisfy" is
 * specific enough that it should never compete with a higher-precision
 * pattern for the same sentence.
 */
function parseSatisfiesRequirement(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const negativePhrase = 'does not satisfy';
  const positivePhrase = 'satisfies';
  const negativeIdx = indexOfPhraseBoundary(lower, negativePhrase);
  const idx = negativeIdx !== -1 ? negativeIdx : indexOfPhraseBoundary(lower, positivePhrase);
  if (idx <= 0) return EMPTY_RESULT;

  const condition = clean(sentence.slice(0, idx));
  const requirement = clean(sentence.slice(idx)); // keep "satisfies X" / "does not satisfy X" intact as the outcome text
  if (condition.length === 0 || requirement.length === 0) return EMPTY_RESULT;

  return {
    candidates: [
      {
        nodeType: 'rule',
        canonicalLabel: `${condition} => ${requirement}`,
        condition,
        action: requirement,
        exceptionConditions: [],
        confidence: 0.7,
        matchedPattern: negativeIdx !== -1 ? 'rule:does-not-satisfy' : 'rule:satisfies',
      },
    ],
    edges: [],
  };
}

// --- Pattern: standalone override ("Exception E overrides rule R.") --------

function parseStandaloneOverride(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const idx = indexOfPhraseBoundary(lower, 'overrides');
  if (idx === -1) return EMPTY_RESULT;
  const exceptionText = clean(sentence.slice(0, idx));
  const targetText = clean(sentence.slice(idx + 'overrides'.length));
  if (exceptionText.length === 0 || targetText.length === 0) return EMPTY_RESULT;
  const exceptionCandidate: ParsedReasoningCandidate = {
    nodeType: 'exception',
    canonicalLabel: exceptionText,
    action: exceptionText,
    exceptionConditions: [],
    confidence: 0.7,
    matchedPattern: 'exception:standalone-overrides',
  };
  return {
    candidates: [exceptionCandidate],
    edges: [{ type: 'overrides', fromLabel: exceptionText, toLabel: targetText, confidence: 0.6 }],
  };
}

// --- Leading clause-number stripping ("7.1 If the claim...", "11.3 If...", "1. Insured...") ---
//
// Real evidence: examples/vertical-test/XO_Commercial_Property_Test_Policy_Compatible.pdf —
// every one of its ~62 numbered clauses (2.4, 7.1, 7.3, 11.3, ...) prefixes an otherwise
// completely ordinary IF/WHEN/BEFORE/MUST/ONLY/WARRANTED sentence with a dotted clause number,
// e.g. "7.1 If the claim amount is greater than INR 10,000 and all required documents are
// present, manager approval is required." Every pattern above requires its cue at the very
// start of the (trimmed) sentence — `lower.startsWith('if ')`, `lower.startsWith('before ')`,
// etc. — so a leading clause number defeats every single one of them, even though the sentence
// is, once you look past the numbering, exactly the kind of clean rule text those patterns are
// built to recognize. This is a real, structural extraction gap for numbered legal/insurance/
// contract clauses generally — an extremely common real-world document convention — not
// specific to this one document or to any one clause's wording or amount.
//
// Deliberately narrow: only a purely numeric, dot-separated marker ("7", "7.1", "11.3.2", ...)
// immediately followed by whitespace is stripped — one or more digits, optionally repeated as
// `.` + digits, then a space/tab. A bare leading number with no dot at all ("30 days...") is
// left untouched (`sawDot` below) precisely because "N " alone is common ordinary sentence
// content (a quantity, a duration) and only the dotted form is a real clause-numbering
// convention, essentially never coincidental sentence content. This never invents or removes
// any rule content — it only relocates where in the sentence pattern-matching starts, exactly
// mirroring how `semantic-type-classifier.ts`'s `containsAnyPhrase` (used for Stage 4's
// knowledge-stage constraint/obligation classification, which is why Stage 4 already produces
// far more constraint nodes than Stage 7 produces rule/decision ones for the same document —
// confirmed by reading both classifiers directly) already looks for its cues anywhere in the
// text rather than only at position 0 — this brings Stage 7's leading-cue patterns up to the
// same tolerance for a real, common document-formatting artifact, nothing more.
function stripLeadingClauseNumber(text: string): string {
  let i = 0;
  const n = text.length;
  let sawDigit = false;
  let sawDot = false;
  while (i < n) {
    const ch = text[i]!;
    if (ch >= '0' && ch <= '9') {
      sawDigit = true;
      i += 1;
      continue;
    }
    if (ch === '.' && sawDigit) {
      sawDot = true;
      i += 1;
      continue;
    }
    break;
  }
  if (!sawDigit || !sawDot) return text; // no marker, or a bare number with no dot ("30 days...") — leave untouched
  if (i >= n || (text[i] !== ' ' && text[i] !== '\t')) return text; // must be followed by whitespace, not e.g. "7.1kg" or a decimal mid-sentence
  const rest = text.slice(i + 1).trimStart();
  return rest.length > 0 ? rest : text; // never strip down to nothing — an all-marker "sentence" has no content to lose the marker for
}

/**
 * Tries every pattern in a fixed, conservative priority order and returns
 * the *first* match — sentences are never double-interpreted by two
 * different patterns, which keeps candidate output predictable and
 * avoids compounding false positives. Returns an empty result (never
 * throws, never guesses) for any sentence that doesn't clearly match one
 * of Stage 7's supported patterns — see the module doc comment.
 *
 * A leading clause number is stripped once, here, before any pattern
 * runs (see `stripLeadingClauseNumber` above) — every pattern below sees
 * the same de-numbered text, so this is a single, centralized adjustment
 * rather than each leading-cue pattern needing its own copy of the same
 * stripping logic.
 */
// --- WS1 recall: liability exclusions and quantified policy terms -----------
//
// Found by the synthetic insurance dev corpus (examples/insurance-dev-corpus): realistic policy wording
// states limits, deductibles, waiting periods, co-payments and liability exclusions in shapes the
// patterns above never matched ("A co-payment of 10% applies...", "Room rent is limited to 1%...",
// "The Insurer is not liable for..."). Both parsers are LOWEST priority (they run after every pattern
// above, so no sentence that parsed before parses differently) and reuse existing node types, so
// they add visibility and provenance, never new executability: `policy` lowers to a constraint with
// no decision-table outcome, exactly like the `must` obligations.

const LIABILITY_EXCLUSION_PHRASES = [
  'is not liable for',
  'are not liable for',
  'not liable for',
  'no benefit is payable',
  'is not payable',
  'are not payable',
  'will not pay',
  'will not cover',
  'is forfeited',
  'are forfeited',
];

function parseLiabilityExclusion(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  const matched = LIABILITY_EXCLUSION_PHRASES.find((phrase) => indexOfPhraseBoundary(lower, phrase) !== -1);
  if (!matched) return EMPTY_RESULT;
  const action = clean(sentence);
  if (action.length === 0) return EMPTY_RESULT;
  return {
    candidates: [
      {
        nodeType: 'prohibition',
        canonicalLabel: action,
        action,
        exceptionConditions: [],
        confidence: 0.7,
        matchedPattern: 'prohibition:liability-exclusion',
      },
    ],
    edges: [],
  };
}

/** Phrases that mark a sentence as stating a numeric term of the cover. A digit in the sentence is also required. */
const QUANTIFIED_TERM_CUES = [
  'deductible',
  'excess of',
  'excess applies',
  'co-payment',
  'co-pay',
  'coinsurance',
  'co-insurance',
  'waiting period',
  'is limited to',
  'are limited to',
  'limited to',
  'up to',
  'maximum payable',
  'maximum of',
  'not exceed',
  'no claim discount',
  'only after',
  'require approval',
  'requires approval',
  'entitled to',
  'entitles the',
];

function containsDigit(text: string): boolean {
  for (const ch of text) if (ch >= '0' && ch <= '9') return true;
  return false;
}

function parseQuantifiedTerm(sentence: string): ParseResult {
  const lower = sentence.toLowerCase();
  if (!containsDigit(sentence)) return EMPTY_RESULT;
  if (sentence.trim().endsWith('?')) return EMPTY_RESULT;
  const cue = QUANTIFIED_TERM_CUES.find((phrase) => indexOfPhraseBoundary(lower, phrase) !== -1);
  if (!cue) return EMPTY_RESULT;
  const text = clean(sentence);
  if (text.split(/\s+/).length < 4) return EMPTY_RESULT;
  return {
    candidates: [
      {
        nodeType: 'policy',
        canonicalLabel: text,
        action: text,
        exceptionConditions: [],
        confidence: 0.65,
        matchedPattern: 'policy:quantified-term',
      },
    ],
    edges: [],
  };
}

export function parseSentence(sentence: string): ParseResult {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return EMPTY_RESULT;
  const withoutClauseNumber = stripLeadingClauseNumber(trimmed);

  const parsers = [
    parsePrerequisite,
    parseSubjectTo,
    parseRule,
    parseTrailingConditional,
    parseThresholdRule,
    parseDeadlineRule,
    parseWarranty,
    parseProhibition,
    parsePassiveExclusion,
    parsePolicy,
    parseAlternative,
    parseJustification,
    parseSatisfiesRequirement,
    parseStandaloneOverride,
    parseLiabilityExclusion,
    parseQuantifiedTerm,
  ];
  for (const parser of parsers) {
    const result = parser(withoutClauseNumber);
    if (result.candidates.length > 0) return result;
  }
  return EMPTY_RESULT;
}
