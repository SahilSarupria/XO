/**
 * Governed learning: execution outcomes can SUGGEST improvements; they can never change authoritative knowledge.
 *
 *   verified outcomes ──► proposals (pure, deterministic) ──► human approval ──► append-only amendment ledger
 *
 * Guarantees enforced here:
 *  - Evidence counts only when it is verified: an accountable verifier, a real timestamp and an evidence reference. Anything
 *    else is IGNORED and reported (never silently counted).
 *  - Thresholds need repetition AND independence (several outcomes from at least two distinct verifiers), so one person's
 *    mistake or one noisy case cannot generate a change.
 *  - Proposals are content-addressed and never mutate their inputs; the rule/policy being discussed is not touched.
 *  - Approval needs a named approver who is NOT among the verifiers of the evidence, and a proposal whose content no longer
 *    matches its id (tampered) is refused.
 *  - The ledger is append-only: one decision per proposal; a rejection is recorded and never counts as approval.
 * Applying an approved amendment to the knowledge graph is deliberately NOT done here: it is a separate, explicit, reviewed
 * step (a recompile with the amendment as a new, provenance-carrying source).
 */
import { createHash } from 'node:crypto';

export type OutcomeKind = 'correct' | 'incorrect' | 'overridden-by-human' | 'insufficient-information';

export interface VerifiedOutcome {
  readonly id: string;
  readonly ruleNodeId: string;
  readonly ruleLabel: string;
  readonly kind: OutcomeKind;
  /** Identity of the person who verified this outcome. Blank = unverified. */
  readonly verifiedBy: string;
  /** ISO-8601 timestamp of the verification. */
  readonly verifiedAt: string;
  /** Pointer to the evidence (case id, ticket, record). */
  readonly evidenceRef: string;
}

export type ProposalKind = 'review-rule' | 'add-exception-candidate' | 'clarification-needed' | 'raise-confidence-candidate';

export interface ChangeProposal {
  readonly id: string;
  readonly kind: ProposalKind;
  readonly ruleNodeId: string;
  readonly ruleLabel: string;
  readonly summary: string;
  readonly rationale: string;
  /** Ids of the verified outcomes this proposal rests on. */
  readonly evidence: readonly string[];
  readonly verifiers: readonly string[];
  readonly status: 'proposed';
}

export interface IgnoredOutcome {
  readonly outcomeId: string;
  readonly reason: string;
}

export interface ProposalThresholds {
  /** Minimum number of verified outcomes of one kind for a rule before anything is proposed. Default 3. */
  readonly minOutcomes?: number;
  /** Minimum DISTINCT verifiers among them. Default 2. */
  readonly minDistinctVerifiers?: number;
  /** Minimum verified-correct outcomes (with zero incorrect) before a confidence-raising candidate. Default 10. */
  readonly minCorrectForConfidence?: number;
}

export interface ProposalResult {
  readonly proposals: readonly ChangeProposal[];
  readonly ignored: readonly IgnoredOutcome[];
}

function invalidReason(o: VerifiedOutcome): string | undefined {
  if (o.verifiedBy.trim().length === 0) return 'no accountable verifier';
  if (o.evidenceRef.trim().length === 0) return 'no evidence reference';
  if (!/^\d{4}-\d{2}-\d{2}/.test(o.verifiedAt) || Number.isNaN(Date.parse(o.verifiedAt)))
    return 'verifiedAt is not a valid ISO-8601 timestamp';
  return undefined;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function content(p: Omit<ChangeProposal, 'id'>): Omit<ChangeProposal, 'id'> {
  return {
    kind: p.kind,
    ruleNodeId: p.ruleNodeId,
    ruleLabel: p.ruleLabel,
    summary: p.summary,
    rationale: p.rationale,
    evidence: p.evidence,
    verifiers: p.verifiers,
    status: p.status,
  };
}
const idOf = (p: Omit<ChangeProposal, 'id'>): string => `prop_${hash(content(p))}`;

export function proposeFromOutcomes(outcomes: readonly VerifiedOutcome[], thresholds: ProposalThresholds = {}): ProposalResult {
  const minOutcomes = thresholds.minOutcomes ?? 3;
  const minVerifiers = thresholds.minDistinctVerifiers ?? 2;
  const minCorrect = thresholds.minCorrectForConfidence ?? 10;

  const ignored: IgnoredOutcome[] = [];
  const valid: VerifiedOutcome[] = [];
  for (const o of outcomes) {
    const reason = invalidReason(o);
    if (reason !== undefined) ignored.push({ outcomeId: o.id, reason });
    else valid.push(o);
  }
  ignored.sort((a, b) => a.outcomeId.localeCompare(b.outcomeId));

  const byRule = new Map<string, VerifiedOutcome[]>();
  for (const o of [...valid].sort((a, b) => a.id.localeCompare(b.id))) byRule.set(o.ruleNodeId, [...(byRule.get(o.ruleNodeId) ?? []), o]);

  const proposals: ChangeProposal[] = [];
  const build = (
    kind: ProposalKind,
    ruleNodeId: string,
    ruleLabel: string,
    group: readonly VerifiedOutcome[],
    summary: string,
    rationale: string,
  ): void => {
    const base: Omit<ChangeProposal, 'id'> = {
      kind,
      ruleNodeId,
      ruleLabel,
      summary,
      rationale,
      evidence: group.map((o) => o.id).sort(),
      verifiers: [...new Set(group.map((o) => o.verifiedBy.trim()))].sort(),
      status: 'proposed',
    };
    proposals.push({ id: idOf(base), ...base });
  };

  for (const [ruleNodeId, group] of [...byRule.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = group[0]!.ruleLabel;
    const of = (k: OutcomeKind): VerifiedOutcome[] => group.filter((o) => o.kind === k);
    const enough = (g: readonly VerifiedOutcome[], n: number): boolean =>
      g.length >= n && new Set(g.map((o) => o.verifiedBy.trim())).size >= minVerifiers;
    const incorrect = of('incorrect');
    if (enough(incorrect, minOutcomes))
      build(
        'review-rule',
        ruleNodeId,
        label,
        incorrect,
        `Review the rule "${label}": ${incorrect.length} verified outcomes were incorrect.`,
        'Repeated, independently verified incorrect outcomes. This proposes a REVIEW; it does not propose a specific change.',
      );
    const overridden = of('overridden-by-human');
    if (enough(overridden, minOutcomes))
      build(
        'add-exception-candidate',
        ruleNodeId,
        label,
        overridden,
        `Consider an exception to "${label}": people overrode it ${overridden.length} times.`,
        'Repeated verified human overrides may indicate an unwritten exception.',
      );
    const insufficient = of('insufficient-information');
    if (enough(insufficient, minOutcomes))
      build(
        'clarification-needed',
        ruleNodeId,
        label,
        insufficient,
        `Clarify the inputs for "${label}": it lacked information ${insufficient.length} times.`,
        'Repeated verified cases where the rule could not be evaluated for missing information.',
      );
    const correct = of('correct');
    if (incorrect.length === 0 && correct.length >= minCorrect && enough(correct, minCorrect)) {
      build(
        'raise-confidence-candidate',
        ruleNodeId,
        label,
        correct,
        `"${label}" was verified correct ${correct.length} times with no incorrect outcomes.`,
        'Sustained verified correctness; a candidate only — confidence is never raised without approval.',
      );
    }
  }
  proposals.sort((a, b) => a.id.localeCompare(b.id));
  return { proposals, ignored };
}

// ── approval and the append-only ledger ───────────────────────────────────────────────────────────────────────────────

export interface ApprovalInput {
  readonly approvedBy: string;
  readonly decision: 'approve' | 'reject';
  readonly note?: string;
}

export interface KnowledgeAmendment {
  readonly id: string;
  readonly proposalId: string;
  readonly ruleNodeId: string;
  readonly decision: 'approve' | 'reject';
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly note?: string;
}

export function approveProposal(proposal: ChangeProposal, approval: ApprovalInput, now: Date = new Date()): KnowledgeAmendment {
  const approver = approval.approvedBy.trim();
  if (approver.length === 0) throw new Error('an accountable approver is required');
  const { id, ...rest } = proposal;
  if (idOf(rest) !== id) throw new Error('the proposal does not match its id (possible tampering); it cannot be approved');
  if (proposal.verifiers.includes(approver))
    throw new Error('the approver verified part of the evidence; approval needs someone who did not (separation of duties)');
  const base = {
    proposalId: proposal.id,
    ruleNodeId: proposal.ruleNodeId,
    decision: approval.decision,
    approvedBy: approver,
    approvedAt: now.toISOString(),
    ...(approval.note !== undefined ? { note: approval.note } : {}),
  };
  return { id: `amd_${hash(base)}`, ...base };
}

export class AmendmentLedger {
  private readonly entries: KnowledgeAmendment[] = [];

  append(amendment: KnowledgeAmendment): void {
    if (this.entries.some((e) => e.proposalId === amendment.proposalId))
      throw new Error(`proposal ${amendment.proposalId} is already decided`);
    this.entries.push(Object.freeze({ ...amendment }));
  }

  /** A frozen snapshot: callers cannot modify the ledger through it. */
  list(): readonly KnowledgeAmendment[] {
    return Object.freeze([...this.entries]);
  }

  approvedFor(ruleNodeId: string): readonly KnowledgeAmendment[] {
    return Object.freeze(this.entries.filter((e) => e.ruleNodeId === ruleNodeId && e.decision === 'approve'));
  }
}
