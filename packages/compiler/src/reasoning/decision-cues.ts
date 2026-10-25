/**
 * WS1-04 (CRD-04): a deliberately BROAD, deterministic detector for sentences that look like they
 * bear a decision — an obligation, a limit, an eligibility test, an exclusion, a deadline.
 *
 * It is the recall safety net for the rule-pattern parser, not an extractor. The parser
 * (`rule-pattern-parser.ts`) is a closed set of precise patterns; a sentence it cannot parse used
 * to vanish without a trace, so the miss rate was invisible. This detector is applied ONLY to the
 * sentences the parser rejected, and what it flags is reported for human review as
 * `UnclassifiedSentence` — it never becomes a node, a capability, or an approval candidate. Being
 * wide (many false positives) is the right trade here: a false positive costs a reviewer a glance,
 * a false negative is a missed rule nobody knows about.
 *
 * Insurance-flavoured because the pilot vertical is insurance operations (CRD-01); the cue
 * families are generic enough to fire on other policy documents too.
 */

interface CueFamily {
  readonly family: string;
  readonly pattern: RegExp;
}

// All patterns are case-insensitive, anchored on word boundaries, and stateless (no /g flag), so a
// shared instance is safe to reuse across calls.
const CUE_FAMILIES: readonly CueFamily[] = [
  {
    family: 'obligation',
    pattern:
      /\b(must|shall|is required to|are required to|required to|obliged to|has to|have to|needs? to|will (?:not )?(?:pay|cover|reimburse|refund|provide|indemni[a-z]+))\b/i,
  },
  {
    family: 'permission',
    pattern:
      /\b(may only|is entitled to|are entitled to|entitled to|is eligible|are eligible|eligible for|is permitted|are permitted|permitted to|authori[sz]ed to)\b/i,
  },
  {
    family: 'prohibition',
    pattern:
      /\b(may not|must not|shall not|cannot|can not|is not permitted|are not permitted|prohibited|forbidden|not allowed|not eligible|ineligible)\b/i,
  },
  {
    family: 'condition',
    pattern:
      /\b(unless|except(?: for| where| when| that)?|provided that|subject to|in the event|only if|on condition that|if and only if|in case of|where the)\b/i,
  },
  {
    family: 'deadline',
    pattern:
      /\b(within \d+|within (?:one|two|three|four|five|six|seven|ten|fourteen|thirty|sixty|ninety)\b|no later than|not later than|prior to|before the|after the|by the end of|waiting period|grace period|cooling[- ]off)\b/i,
  },
  {
    family: 'limit',
    pattern:
      /\b(up to|at most|at least|no more than|no less than|not exceed|exceeds?|maximum|minimum|limit of|limited to|sub-?limit|aggregate|per (?:claim|occurrence|event|policy|year|day)|deductible|excess|co-?pay(?:ment)?|co-?insurance)\b/i,
  },
  {
    family: 'coverage',
    pattern:
      /\b(is covered|are covered|not covered|excluded|exclusions?|insured|indemnif(?:y|ied|ication)|reimburs\w*|payable|liable|liability|benefit(?:s)? (?:is|are|shall)|claims?)\b/i,
  },
  { family: 'quantity', pattern: /(?:[$€£₹]\s?\d|\d\s?%|\d+\s?(?:days?|business days?|working days?|weeks?|months?|years?|hours?)\b)/i },
];

/** Sentences this short are headings or fragments, not rules. */
const MIN_WORDS = 4;

/**
 * Returns the sorted, de-duplicated cue family names found in `sentence`; empty when the sentence
 * does not look decision-bearing. A single weak family (`coverage` or `quantity` alone) is not
 * enough: those words appear in plain description ("This claim form has 3 pages"), so they only
 * count alongside a second family.
 */
export function findDecisionCues(sentence: string): readonly string[] {
  const text = sentence.trim();
  if (text.split(/\s+/).filter((w) => w.length > 0).length < MIN_WORDS) return [];
  const found = CUE_FAMILIES.filter((f) => f.pattern.test(text)).map((f) => f.family);
  const unique = [...new Set(found)].sort();
  const strong = unique.filter((f) => f !== 'coverage' && f !== 'quantity');
  return strong.length > 0 || unique.length >= 2 ? unique : [];
}
