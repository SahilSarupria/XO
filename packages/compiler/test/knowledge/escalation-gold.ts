/**
 * HAND-ANNOTATED GOLD for knowledge extraction on REAL units from `examples/vertical-test/*.pdf`.
 *
 * Provenance and limits, stated plainly: authored by a single annotator (the engineer who wrote the escalation gate), AFTER seeing
 * the rule extractor's output for these units, and stratified by the gate's own decision classes. It is therefore small (42 units),
 * not independent, and not blind. Treat results computed from it as a diagnostic of the gate's targeting, not as a benchmark.
 *
 * Annotation rules:
 *  - `entities`: surface forms a domain reader would keep as knowledge nodes: named parties/organizations/people/places, defined
 *    terms, and named documents/clauses/categories. Excluded: sentence-initial common words, field labels, currency codes, dates,
 *    section numbers, URLs/ids.
 *  - Matching is by normalized exact string: lowercase, whitespace collapsed, trailing punctuation and a leading "the" stripped.
 *    A boundary error (e.g. "Any Other Items: INR" vs "Any Other Items") is one false positive AND one miss.
 *  - `primaryOk`: the rule extractor's unit-primary node is acceptable when its label is a faithful heading/summary of the unit AND
 *    its type is plausible (e.g. type `action` on a non-operational heading, or a label unrelated to the text, is NOT ok).
 *  - Units are keyed by (file prefix, first 50 whitespace-normalized characters of content). Two empty units and one duplicate were
 *    left out because they cannot be keyed uniquely.
 */
export interface GoldUnit {
  readonly file: 'XO_Com' | 'burgla' | 'Aastha';
  readonly textStart: string;
  readonly entities: readonly string[];
  readonly primaryOk: boolean;
}

export const GOLD: readonly GoldUnit[] = [
  {
    file: 'XO_Com',
    textStart: '1.1 Insured Property means buildings, machinery, s',
    entities: ['Insured Property', 'Claim', 'Business Hours', 'Business Day', 'Deductible', 'Schedule', 'Policy', 'Insured'],
    primaryOk: false,
  },
  {
    file: 'XO_Com',
    textStart: '2.1 Subject to the terms, conditions and exclusion',
    entities: ['Policy', 'Insurer', 'Insured', 'Insured Property', 'Schedule', 'Sum Insured'],
    primaryOk: true,
  },
  {
    file: 'XO_Com',
    textStart: '3.1 A deductible of INR 25,000 applies to each cov',
    entities: ['Schedule', 'Policy Period', 'deductible'],
    primaryOk: false,
  },
  { file: 'XO_Com', textStart: '4.1 The Insured must notify the Insurer of a loss ', entities: ['Insured', 'Insurer'], primaryOk: false },
  { file: 'XO_Com', textStart: '5.1 Flood damage is excluded. 5.2 Loss caused sole', entities: ['Insured', 'Schedule'], primaryOk: true },
  { file: 'XO_Com', textStart: '6.1 The Insured must report suspected theft to the', entities: ['Insured', 'Insurer'], primaryOk: false },
  { file: 'XO_Com', textStart: '6.5 The policy is not valid for a claim, if any of', entities: ['policy'], primaryOk: true },
  { file: 'XO_Com', textStart: '7.1 If the claim amount is greater than INR 10,000', entities: ['Policy'], primaryOk: false },
  { file: 'XO_Com', textStart: '8.1 A claim notification received within 7 calenda', entities: ['Policy Period'], primaryOk: false },
  { file: 'XO_Com', textStart: '9.1 When manager approval is required, the claim m', entities: ['loss adjuster'], primaryOk: true },
  { file: 'XO_Com', textStart: '10.1 The Insurer may consider whether damage was r', entities: ['Insurer'], primaryOk: true },
  {
    file: 'XO_Com',
    textStart: '11.1 If the Policy is active, the loss occurs duri',
    entities: ['Policy', 'Policy Period'],
    primaryOk: true,
  },
  { file: 'XO_Com', textStart: 'Case A: claim_amount = INR 15,000; policy active; ', entities: [], primaryOk: false },
  { file: 'burgla', textStart: 'Digit Burglary Insurance Policy', entities: ['Digit Burglary Insurance Policy'], primaryOk: false },
  { file: 'burgla', textStart: 'UIN: IRDAN158RP0019V02201920', entities: [], primaryOk: true },
  { file: 'burgla', textStart: 'Go Digit General Insurance Ltd', entities: ['Go Digit General Insurance Ltd'], primaryOk: false },
  { file: 'burgla', textStart: 'Validate your Policy Copy', entities: ['Policy Copy'], primaryOk: true },
  {
    file: 'burgla',
    textStart: 'Policy Number D279250237 Receipt Number RA32223401',
    entities: ['AASTHA INSURANCE BROKER PRIVATE LIMITED'],
    primaryOk: false,
  },
  { file: 'burgla', textStart: 'Insured Details:', entities: [], primaryOk: false },
  { file: 'burgla', textStart: 'GST State Code 27 GSTIN Number Unregistered xxxxxx', entities: [], primaryOk: false },
  { file: 'burgla', textStart: 'Total Sum Insured of the Property INR 450000', entities: ['Total Sum Insured'], primaryOk: false },
  { file: 'burgla', textStart: 'Contents', entities: [], primaryOk: true },
  {
    file: 'burgla',
    textStart: 'a.1.Valuable content 0.00 a.2.All other content 0.',
    entities: ['Valuable content', 'All other content'],
    primaryOk: true,
  },
  { file: 'burgla', textStart: 'Any Other Items: INR 450000', entities: ['Any Other Items'], primaryOk: true },
  { file: 'burgla', textStart: 'First Loss Sum Insured', entities: ['First Loss Sum Insured'], primaryOk: false },
  { file: 'burgla', textStart: 'Escalation Clause (Maximum 25% of the', entities: ['Escalation Clause'], primaryOk: false },
  {
    file: 'burgla',
    textStart: 'Housebreaking Nominee Details of the Insured & Ins',
    entities: ['Nominee Details', 'Family Members'],
    primaryOk: false,
  },
  { file: 'burgla', textStart: '-- -- -- --', entities: [], primaryOk: false },
  { file: 'burgla', textStart: '--', entities: [], primaryOk: false },
  {
    file: 'burgla',
    textStart: 'Designation of Property Clause Property/Goods Held',
    entities: [
      'Designation of Property Clause',
      'Property/Goods Held in Trust Clause',
      'Cyber Risk Exclusion Clause',
      'Sanctions Limitation and Exclusion Clause',
    ],
    primaryOk: false,
  },
  { file: 'burgla', textStart: 'Warranted that for stocks of high value and low vo', entities: [], primaryOk: true },
  { file: 'burgla', textStart: 'Warranted that there is 24 hours security in the p', entities: [], primaryOk: false },
  { file: 'burgla', textStart: 'Gross Invoice Number Invoice Date Net Premium Igst', entities: [], primaryOk: false },
  {
    file: 'burgla',
    textStart: '1. *Cheque dishonor / Non-receipt of payment: If p',
    entities: ['Digit Burglary Insurance Policy', 'Go Digit General Insurance Ltd'],
    primaryOk: true,
  },
  {
    file: 'burgla',
    textStart: 'Praveen Bhat Senior Vice President - Customer Expe',
    entities: ['Praveen Bhat', 'Customer Experience'],
    primaryOk: false,
  },
  { file: 'burgla', textStart: 'praveen.bhat@godigit.com Authorized Signatory Prin', entities: ['Bengaluru'], primaryOk: false },
  {
    file: 'burgla',
    textStart: 'Go Digit General Insurance Limited (Digit/GDGIL) |',
    entities: ['Go Digit General Insurance Limited', 'Go Digit Solutions Private Limited', 'Bengaluru', 'Pune', 'Mumbai', 'Maharashtra'],
    primaryOk: false,
  },
  { file: 'Aastha', textStart: 'internal sales personnel, business associates, and', entities: ['POSPs'], primaryOk: false },
  {
    file: 'Aastha',
    textStart: 'period, which includes IRDA-prescribed brokerage p',
    entities: ['CRM', 'Policy Booking Report', 'IRDA'],
    primaryOk: false,
  },
  { file: 'Aastha', textStart: 'Data Mapping: Map the CRM policy records against t', entities: ['CRM'], primaryOk: true },
  { file: 'Aastha', textStart: 'Calculate and book TDS for each receipt.', entities: ['TDS'], primaryOk: true },
  { file: 'Aastha', textStart: 'Partner Payouts: Calculate channel-wise revenue sh', entities: ['Partner Payouts'], primaryOk: true },
];
