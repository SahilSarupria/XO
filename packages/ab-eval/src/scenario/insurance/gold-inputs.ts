import type { TreeInput } from '@xo/capability-layer';

/**
 * The oracle's vocabulary, written as an operator's field list would be (names and descriptions in the desk's own
 * words). The fact binder reads a compiled tree's inputs from these; it is a proxy for a model reading the schema.
 */
export const INSURANCE_INPUTS: readonly TreeInput[] = [
  { name: 'claim_type', type: 'string', enum: ['collision', 'glass', 'theft'], description: 'type of claim' },
  { name: 'injury_involved', type: 'boolean', description: 'whether someone was hurt in the claim (bodily injury involved)' },
  { name: 'policy_in_force', type: 'boolean', description: 'whether the policy was in force on the date of loss (not lapsed)' },
  { name: 'claims_last_12m', type: 'number', description: 'number of claims the policyholder made in the previous 12 months' },
  { name: 'days_to_report', type: 'number', derivable: true, description: 'days after the loss that the claim was reported' },
  { name: 'police_report_filed', type: 'boolean', description: 'whether a police report has been filed' },
  { name: 'repair_estimate_usd', type: 'number', description: 'repair estimate in USD' },
  { name: 'vehicle_value_usd', type: 'number', description: "vehicle's market value in USD" },
  { name: 'rental_coverage', type: 'boolean', description: 'whether the policyholder has rental coverage' },
  { name: 'rental_days', type: 'number', description: 'number of rental days' },
] as TreeInput[];
