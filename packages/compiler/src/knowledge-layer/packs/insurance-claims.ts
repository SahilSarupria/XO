import type { ConceptKind, DomainConcept, DomainKnowledgePack } from '../types.js';

const c = (id: string, label: string, kind: ConceptKind, definition: string, synonyms: readonly string[] = [], weight = 1): DomainConcept => ({ id, label, kind, definition, synonyms, weight });

export const INSURANCE_CLAIMS_PACK: DomainKnowledgePack = {
  id: 'insurance-claims',
  version: '0.1.0',
  domain: 'insurance',
  description: 'Property, casualty and general insurance policy wording and claims handling.',
  provenance: 'Authored for the XO compiler from general public knowledge of insurance terminology; not yet expert-reviewed.',
  status: 'draft',
  concepts: [
    c('insurer', 'insurer', 'entity', 'The party that issues the policy and indemnifies covered loss.', ['underwriter', 'carrier']),
    c('insured', 'insured', 'entity', 'The party protected by the policy whose loss is indemnified.', ['policyholder', 'assured']),
    c('policy', 'policy', 'term', 'The insurance contract between insurer and insured.', [], 0.4),
    c('premium', 'premium', 'term', 'The price paid for insurance cover.', []),
    c('deductible', 'deductible', 'constraint', 'The amount of each loss the insured bears before the insurer pays.', ['excess', 'retention', 'co-payment']),
    c('sum-insured', 'sum insured', 'constraint', 'The maximum amount the insurer will pay under the policy or a section of it.', ['limit of liability', 'policy limit', 'coverage limit', 'indemnity limit']),
    c('claim', 'claim', 'process', 'A demand for payment arising from an insured loss.', [], 0.4),
    c('exclusion', 'exclusion', 'condition', 'A cause or type of loss the policy does not cover.', ['excluded peril']),
    c('endorsement', 'endorsement', 'term', 'A written change that adds to, removes or modifies policy terms.', ['rider', 'addendum']),
    c('peril', 'peril', 'term', 'A cause of loss, such as fire or theft, that the policy may cover or exclude.', ['insured peril', 'insured event']),
    c('waiting-period', 'waiting period', 'constraint', 'A period after inception during which a cover or claim does not yet apply.', []),
    c('loss-adjuster', 'loss adjuster', 'entity', 'A professional who investigates and assesses the extent of an insured loss.', ['claims adjuster', 'surveyor']),
    c('indemnity', 'indemnity', 'term', 'Compensation restoring the insured to their financial position before the loss.', ['indemnify']),
    c('subrogation', 'subrogation', 'term', 'The insurer taking over the insured’s rights against a party responsible for the loss.', []),
    c('underwriting', 'underwriting', 'process', 'Assessing and pricing risk before accepting it.', []),
    c('schedule', 'schedule', 'term', 'The part of the policy listing the insured, property, sums insured and deductibles.', [], 0.4),
    c('proposal-form', 'proposal form', 'term', 'The application in which the proposer discloses material facts before cover is granted.', ['proposal']),
    c('no-claim-bonus', 'no-claim bonus', 'term', 'A discount for a period without claims.', ['no claims discount']),
  ],
  relationships: [
    { from: 'insured', type: 'holds', to: 'policy' },
    { from: 'insurer', type: 'issues', to: 'policy' },
    { from: 'policy', type: 'limits-payment-by', to: 'sum-insured' },
    { from: 'claim', type: 'is-reduced-by', to: 'deductible' },
    { from: 'exclusion', type: 'removes-cover-for', to: 'peril' },
    { from: 'endorsement', type: 'modifies', to: 'policy' },
  ],
  patterns: [
    { id: 'deductible-application', description: 'A per-occurrence amount the insured bears.', example: 'A deductible of 25,000 applies to each covered occurrence.', conceptIds: ['deductible'] },
    { id: 'exclusion-unless-endorsed', description: 'An exclusion that an endorsement can lift.', example: 'Flood damage is excluded unless a flood endorsement is recorded.', conceptIds: ['exclusion', 'endorsement'] },
    { id: 'payment-cap', description: 'Payment never exceeds the sum insured.', example: 'The amount payable shall not exceed the sum insured.', conceptIds: ['sum-insured'] },
  ],
};
