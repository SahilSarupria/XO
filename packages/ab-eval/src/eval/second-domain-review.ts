import {
  applyReviewDecisions,
  type ClauseProposal,
  type Extraction,
  type PolicyArtifacts,
  type ReviewDecision,
  type ReviewItem,
} from '@xo/compiler';
import { compileInsurance } from './second-domain.js';

/**
 * What a customer's reviewer would do with the insurance manual's review list: accept, edit or reject each sentence.
 * Every edit passes the same deterministic checks as a model proposal (verbatim quote, numbers present in the quote,
 * parseable expressions over declared facts, tree must not get worse). Written AFTER the untuned baseline was recorded.
 */
const F = (name: string, type: 'number' | 'boolean' | 'string', description: string) => ({ name, type, description });
const gate = (
  quote: string,
  when: string,
  decision: string,
  reason: string,
  facts: ReturnType<typeof F>[],
  target?: string,
): ClauseProposal => ({
  quote,
  facts,
  step: { kind: 'gate', when, decision, reason, ...(target ? { target } : {}) },
});

const claimType = F('claim_type', 'string', 'type of claim');
const days = F('days_to_report', 'number', 'days after the loss that the claim was reported');
const estimate = F('repair_estimate_usd', 'number', 'repair estimate in USD');
const value = F('vehicle_value_usd', 'number', "vehicle's market value in USD");

const EDITS: Record<string, ClauseProposal> = {
  'If the policy had lapsed, the claim is denied.': gate(
    'If the policy had lapsed, the claim is denied',
    'policy_in_force == false',
    'deny',
    'POLICY_LAPSED',
    [F('policy_in_force', 'boolean', 'whether the policy was in force on the date of loss')],
  ),
  'Collision and theft claims must be reported within 30 days of the loss.': gate(
    'Collision and theft claims must be reported within 30 days of the loss',
    "(claim_type == 'collision' || claim_type == 'theft') && days_to_report > 30",
    'deny',
    'REPORTED_LATE',
    [claimType, days],
  ),
  'Glass claims may be reported up to 90 days after the loss.': gate(
    'Glass claims may be reported up to 90 days after the loss',
    "claim_type == 'glass' && days_to_report > 90",
    'deny',
    'REPORTED_LATE',
    [claimType, days],
  ),
  'A theft claim is only payable once a police report has been filed.': gate(
    'A theft claim is only payable once a police report has been filed',
    "claim_type == 'theft' && police_report_filed == false",
    'deny',
    'NO_POLICE_REPORT',
    [claimType, F('police_report_filed', 'boolean', 'whether a police report has been filed')],
  ),
  'The desk pays the repair estimate less the deductible.': {
    quote: 'The desk pays the repair estimate less the deductible',
    facts: [],
    step: { kind: 'finish', decision: 'approve', amount: 'payable_base - deductible + rental_payment', reason: 'APPROVED' },
  },
  "Where the repair estimate is more than 75% of the vehicle's market value, the vehicle is a total loss and the desk pays the market value less the deductible instead.":
    {
      quote: "the repair estimate is more than 75% of the vehicle's market value",
      facts: [estimate, value],
      step: {
        kind: 'assign',
        set: { payable_base: 'repair_estimate_usd > 0.75 * vehicle_value_usd ? vehicle_value_usd : repair_estimate_usd' },
      },
    },
  'If the repair estimate does not exceed the deductible, nothing is payable and the claim is denied.': gate(
    'If the repair estimate does not exceed the deductible, nothing is payable and the claim is denied',
    'repair_estimate_usd <= deductible',
    'deny',
    'NOTHING_PAYABLE',
    [estimate],
  ),
  'If the policyholder has rental coverage, rental is reimbursed at $40 per day for a maximum of 14 days.': {
    quote: 'rental is reimbursed at $40 per day for a maximum of 14 days',
    facts: [
      F('rental_coverage', 'boolean', 'whether the policyholder has rental coverage'),
      F('rental_days', 'number', 'number of rental days'),
    ],
    step: { kind: 'assign', set: { rental_payment: 'rental_coverage ? 40 * min(rental_days, 14) : 0' } },
  },
  'Payments above $15,000 need Senior Adjuster approval; the desk escalates to the Senior Adjuster and does not set a payout.': gate(
    'Payments above $15,000 need Senior Adjuster approval',
    'payable_base - deductible + rental_payment > 15000',
    'escalate',
    'OVER_AUTHORITY',
    [],
    'Senior Adjuster',
  ),
};
// sentences the compiler already covers elsewhere, or that state no rule
const REJECT = new Set([
  'Internal use only.',
  'The desk never settles a claim involving bodily injury, whatever the amount.',
  'A claim is payable only if the policy was in force on the date of loss.',
  'A claim reported after its deadline is denied.',
  'If there is no police report, the claim is denied.',
]);

export interface ReviewedRun {
  readonly artifacts: PolicyArtifacts;
  readonly refused: readonly { readonly sentence: string; readonly reasons: readonly string[] }[];
  readonly accepted: number;
  readonly rejected: number;
  readonly stillUnreviewed: readonly string[];
}

/** Compile, review every listed sentence with the decisions above, and recompile with the reviewed extraction. */
export async function compileInsuranceReviewed(): Promise<ReviewedRun> {
  const first = await compileInsurance();
  const extraction: Extraction = {
    program: first.program,
    recognized: [],
    unrecognized: first.review.unrecognized,
    decisionSentences: first.review.decisionSentences,
  };
  const items: ReviewItem[] = first.review.unrecognized.map((u) => ({ ...u, reasons: ['not recognised by the pattern extractor'] }));
  const decisions: ReviewDecision[] = [];
  // the finish-step sentence is applied last-to-first within its sentence: base, then override (both on one document sentence order)
  for (const u of first.review.unrecognized) {
    if (REJECT.has(u.sentence)) decisions.push({ sentence: u.sentence, action: 'reject' });
    else if (EDITS[u.sentence] !== undefined) decisions.push({ sentence: u.sentence, action: 'edit', proposal: EDITS[u.sentence]! });
  }
  const out = applyReviewDecisions(extraction, items, decisions);
  const artifacts = await compileInsurance({ extraction: out.extraction });
  return {
    artifacts,
    refused: out.refused,
    accepted: out.ledger.accepted.length,
    rejected: out.ledger.rejected.length,
    stillUnreviewed: out.extraction.unrecognized.map((u) => u.sentence),
  };
}
