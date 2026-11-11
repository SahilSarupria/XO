import type { ConceptKind, DomainConcept, DomainKnowledgePack } from '../types.js';

const c = (id: string, label: string, kind: ConceptKind, definition: string, synonyms: readonly string[] = [], weight = 1): DomainConcept => ({ id, label, kind, definition, synonyms, weight });

export const FINANCE_LENDING_PACK: DomainKnowledgePack = {
  id: 'finance-lending',
  version: '0.1.0',
  domain: 'finance',
  description: 'Loan, credit facility and lending agreement terminology.',
  provenance: 'Authored for the XO compiler from general public knowledge of lending terminology; not yet expert-reviewed.',
  status: 'draft',
  concepts: [
    c('borrower', 'borrower', 'entity', 'The party that receives funds and must repay them.', ['obligor', 'debtor']),
    c('lender', 'lender', 'entity', 'The party that provides funds under the agreement.', ['creditor', 'financier']),
    c('loan', 'loan', 'term', 'An amount of money advanced to be repaid, usually with interest.', ['advance'], 0.6),
    c('principal', 'principal', 'term', 'The original amount borrowed, excluding interest.', ['principal amount']),
    c('interest', 'interest', 'term', 'The cost of borrowing, accruing on the outstanding principal.', ['interest rate', 'coupon'], 0.4),
    c('collateral', 'collateral', 'term', 'An asset pledged to secure repayment.', ['security interest', 'pledged asset']),
    c('maturity', 'maturity', 'term', 'The date on which the loan must be fully repaid.', ['maturity date', 'final repayment date']),
    c('repayment', 'repayment', 'process', 'Payment of principal and interest on a schedule.', ['instalment', 'installment', 'amortisation', 'amortization'], 0.8),
    c('default', 'default', 'condition', 'A failure to meet the agreement, such as missing a payment.', [], 0.4),
    c('event-of-default', 'event of default', 'condition', 'A specified event that lets the lender accelerate or enforce.', []),
    c('covenant', 'covenant', 'constraint', 'A promise to do, or refrain from, specified things during the loan.', ['financial covenant']),
    c('guarantor', 'guarantor', 'entity', 'A party that promises to repay if the borrower does not.', ['surety']),
    c('prepayment', 'prepayment', 'process', 'Repaying all or part of the loan before maturity.', ['early repayment']),
    c('tenor', 'tenor', 'term', 'The length of time until the loan matures.', ['loan term']),
    c('drawdown', 'drawdown', 'process', 'The borrower’s withdrawal of funds under a facility.', ['utilisation', 'utilization']),
    c('facility', 'facility', 'term', 'A committed arrangement under which funds can be borrowed.', ['credit facility'], 0.4),
    c('credit-score', 'credit score', 'term', 'A numeric assessment of the borrower’s creditworthiness.', ['credit rating']),
  ],
  relationships: [
    { from: 'loan', type: 'issued-to', to: 'borrower' },
    { from: 'lender', type: 'provides', to: 'loan' },
    { from: 'collateral', type: 'secures', to: 'loan' },
    { from: 'event-of-default', type: 'allows-lender-to-enforce', to: 'collateral' },
    { from: 'repayment', type: 'reduces', to: 'principal' },
  ],
  patterns: [
    { id: 'interest-accrual', description: 'Interest accrues at a stated annual rate.', example: 'Interest accrues at 8% per annum on the outstanding principal.', conceptIds: ['interest', 'principal'] },
    { id: 'default-enforcement', description: 'Default entitles the lender to enforce security.', example: 'On an event of default the lender may enforce the collateral.', conceptIds: ['event-of-default', 'lender', 'collateral'] },
  ],
};
