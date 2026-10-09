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

const DECISION_VERBS = ['approve', 'approves', 'reject', 'rejects', 'grant', 'grants', 'deny', 'denies', 'accept', 'accepts', 'decline', 'declines'];

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
    edges.push({ type: 'overrides', fromLabel: exceptionCandidate.canonicalLabel, toLabel: primaryCandidate.canonicalLabel, confidence: 0.7 });
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
    edges.push({ type: 'alternative_to', fromLabel: primaryCandidate.canonicalLabel, toLabel: altCandidate.canonicalLabel, confidence: 0.65 });
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
    if (lower.slice(idx + 1).trimStart().startsWith('if ')) return idx;
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
    const subjectWords = sentence.slice(0, mustIdx).trim().split(/\s+/).filter((w) => w.length > 0);
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
export function parseSentence(sentence: string): ParseResult {
  const trimmed = sentence.trim();
  if (trimmed.length === 0) return EMPTY_RESULT;
  const withoutClauseNumber = stripLeadingClauseNumber(trimmed);

  const parsers = [
    parsePrerequisite,
    parseSubjectTo,
    parseRule,
    parseTrailingConditional,
    parseWarranty,
    parseProhibition,
    parsePassiveExclusion,
    parsePolicy,
    parseAlternative,
    parseJustification,
    parseSatisfiesRequirement,
    parseStandaloneOverride,
  ];
  for (const parser of parsers) {
    const result = parser(withoutClauseNumber);
    if (result.candidates.length > 0) return result;
  }
  return EMPTY_RESULT;
}