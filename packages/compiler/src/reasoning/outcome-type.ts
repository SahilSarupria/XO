/**
 * Typed decision outcome of a rule's outcome clause, derived deterministically from the TEXT ONLY.
 *
 * Why this exists: outcomes used to be free text, so "approve", "deny", "escalate" and "approval is required" were
 * indistinguishable downstream and routinely collapsed into one another. Each value here has distinct semantics:
 *  - approve:           the text grants / permits / lets something proceed.
 *  - deny:              the text refuses / rejects / excludes / blocks.
 *  - requires_approval: the text makes a decision conditional on someone's approval (the approval itself is NOT granted).
 *  - escalate:          the text explicitly hands the case to another party/tier ("escalate", "refer", "route to").
 *  - none:              no decision outcome stated (an action, an obligation, a permission to act, or "not required").
 *
 * What this is NOT: it never infers an outcome the text does not state, never turns missing information into a denial,
 * and never turns an unrecognised clause into an escalation (an unresolved clause is a compiler state, not an outcome).
 * Language cues only — no subject-matter vocabulary.
 */

export type OutcomeType = 'approve' | 'deny' | 'requires_approval' | 'escalate' | 'none';

const APPROVAL_NOUN = String.raw`(?:approval|authori[sz]ation|sign-?off|consent)`;
const NOT_REQUIRED = new RegExp(String.raw`\b${APPROVAL_NOUN}\b[^.]*\b(?:is|are)\s+not\s+(?:required|needed|necessary)\b|\bno\s+${APPROVAL_NOUN}\b`, 'i');
const REQUIRES_APPROVAL = new RegExp(
  [
    String.raw`\b${APPROVAL_NOUN}\b[^.]*\b(?:is|are)\s+(?:required|needed|necessary)\b`,
    String.raw`\b(?:requires?|needs?|obtain|obtains|must\s+obtain|must\s+receive|subject\s+to)\b[^.]*\b${APPROVAL_NOUN}\b`,
    String.raw`\bmust\s+be\s+(?:approved|authori[sz]ed)\b`,
  ].join('|'),
  'i',
);
const ESCALATE = /\b(?:escalate[sd]?|(?:refer(?:red|s)?|route[sd]?|forward(?:ed|s)?)\b[^.,;]{0,40}\bto\b|hand(?:ed)?\s+(?:over|off)\s+to)\b/i;
const DENY =
  /\b(?:den(?:y|ies|ied)|reject(?:s|ed)?|declin(?:e|es|ed)|refus(?:e|es|ed)|(?:is|are)\s+(?:excluded|void|invalid)|(?:is|are)\s+not\s+(?:covered|permitted|allowed|eligible|payable|valid)|(?:must|shall|may)\s+not\s+(?:proceed|be\s+(?:paid|approved|granted|processed|accepted)))\b/i;
const APPROVE =
  /\b(?:approve[sd]?|grant(?:s|ed)?|accept(?:s|ed)?|(?:is|are)\s+(?:permitted|allowed|covered|eligible|payable)|(?:may|can|must|shall)\s+proceed)\b/i;

export function classifyOutcomeType(outcomeText: string): OutcomeType {
  const text = outcomeText.trim();
  if (text.length === 0) return 'none';
  if (NOT_REQUIRED.test(text)) return 'none';
  if (REQUIRES_APPROVAL.test(text)) return 'requires_approval';
  if (ESCALATE.test(text)) return 'escalate';
  if (DENY.test(text)) return 'deny';
  if (APPROVE.test(text)) return 'approve';
  return 'none';
}
