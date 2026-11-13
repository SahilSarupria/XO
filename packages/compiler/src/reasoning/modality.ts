/**
 * Deterministic, domain-neutral deontic classification of a rule's outcome clause.
 *
 * Modality is a property of the LANGUAGE ("must", "may", "should"), never of the subject matter, so this module holds
 * no industry vocabulary. It exists because the pipeline used to carry modality only inside free-text outcome strings:
 * a permission ("the supplier may suspend the service") was indistinguishable from a requirement downstream and could
 * be minted as a mandatory executable rule.
 *
 * Semantics (kept deliberately small and explicit):
 *  - prohibition: "must not", "shall not", "may not", "cannot", "is (not) permitted/prohibited/forbidden/allowed",
 *    "never". Polarity is always negative.
 *  - obligation:  "must", "shall", "is/are required", "needs/has to". Polarity is negative for "is not required"
 *    (an exemption from a requirement, not a prohibition).
 *  - advisory:    "should", "ought to", "is recommended".
 *  - permission:  "may", "can", "is permitted/allowed/entitled". "may be rejected" is a permission to reject.
 *  - obligation also covers a bare imperative instruction ("notify the owner"), recognised by a leading base-form
 *    verb from a small, general-purpose action-verb list — an instruction is a requirement without a modal.
 *  - mixed:       the clause contains BOTH a requirement and a prohibition ("must keep X and must not disclose Y"). It is
 *    reported as such instead of being forced into one modality; it should be split before it is executed.
 *  - declarative: anything else ("is excluded", "does not apply"); polarity still reflects a negation.
 *
 * Precedence is prohibition > obligation > advisory > permission > declarative, so "must not" is never read as the
 * obligation "must".
 */

export type Modality = 'obligation' | 'permission' | 'prohibition' | 'advisory' | 'declarative' | 'mixed';
/** `mixed` polarity accompanies `mixed` modality only: a clause that contains both a requirement and a prohibition has no single polarity. */
export type Polarity = 'positive' | 'negative' | 'mixed';
export interface ModalityClassification {
  readonly modality: Modality;
  readonly polarity: Polarity;
}

const PROHIBITION =
  /\b(?:must\s+not|shall\s+not|may\s+not|cannot|can\s*not|(?:is|are)\s+not\s+(?:permitted|allowed|to\s+be)|(?:is|are)\s+(?:prohibited|forbidden|barred)|must\s+never|never)\b/i;
const OBLIGATION =
  /\b(?:must|shall|(?:is|are)\s+(?:not\s+)?required|(?:needs?|has|have)\s+to|will|(?:is|are)\s+(?:also\s+)?(?:expected\s+to|responsible\s+for)|responsibility\s+to)\b/i;
const ADVISORY = /\b(?:should|ought\s+to|(?:is|are)\s+(?:recommended|encouraged))\b/i;
const PERMISSION = /\b(?:may|can|(?:is|are)\s+(?:permitted|allowed|entitled))\b/i;
const IMPERATIVE_LEAD =
  /^(?:please\s+)?(?:notify|escalate|refer|route|assign|record|log|submit|send|return|provide|review|approve|reject|deny|grant|accept|decline|suspend|terminate|cancel|pay|report|forward|hold|release|flag|open|close|issue|inform|alert|contact|request|verify|confirm|apply|charge|refund|process|settle|reserve|block|refuse|stop|start|complete|file)\b/i;
const NEGATION = /\b(?:not|never|no|cannot|neither|nor)\b/i;

export function classifyModality(outcomeText: string): ModalityClassification {
  const text = outcomeText.trim();
  if (PROHIBITION.test(text)) {
    // A prohibition alongside a separate, positive requirement is neither alone.
    const withoutProhibitions = text.replace(new RegExp(PROHIBITION.source, 'gi'), ' ');
    if (OBLIGATION.test(withoutProhibitions) && !NEGATION.test(withoutProhibitions.match(OBLIGATION)?.[0] ?? '')) {
      return { modality: 'mixed', polarity: 'mixed' };
    }
    return { modality: 'prohibition', polarity: 'negative' };
  }
  if (IMPERATIVE_LEAD.test(text) && !PERMISSION.test(text) && !ADVISORY.test(text)) return { modality: 'obligation', polarity: 'positive' };
  if (OBLIGATION.test(text)) return { modality: 'obligation', polarity: NEGATION.test(text) ? 'negative' : 'positive' };
  if (ADVISORY.test(text)) return { modality: 'advisory', polarity: NEGATION.test(text) ? 'negative' : 'positive' };
  if (PERMISSION.test(text)) return { modality: 'permission', polarity: 'positive' };
  return { modality: 'declarative', polarity: NEGATION.test(text) ? 'negative' : 'positive' };
}
