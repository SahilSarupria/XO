/**
 * INDEPENDENT-AS-POSSIBLE EVALUATION SET for knowledge extraction, built for the escalation-policy validation.
 *
 * Method (so a reader can judge it):
 *  - Units are the real non-fragment units (>= 4 words) of the three `examples/vertical-test` PDFs that are NOT in
 *    `escalation-gold.ts` (the earlier set, which was annotated after seeing rule output and was used to choose the default threshold).
 *    The two sets are disjoint; this one must not be used to tune anything before the final held-out evaluation.
 *  - The dev/held-out split was fixed BEFORE annotation by `sha256(file + "|" + textStart)` parity (even = dev), so it cannot depend on
 *    any extractor or model result.
 *  - Labels were written from the RAW UNIT TEXT ONLY, before any rule or model output for these units was viewed.
 *  - Limitations: one annotator, who is the same engineer who built the gate and who had seen the earlier gold; no inter-annotator
 *    agreement; 43 units (21 dev, 22 held-out), so results are far too small for significance claims; many units are form fragments;
 *    the annotation rules are judgement calls, e.g. field labels are excluded while named categories/clauses/cover items are included.
 *
 * Annotation rules: `entities` are surface forms a domain reader would keep as knowledge terms: named parties, organizations, people,
 * places, defined terms, and named documents/clauses/categories/cover items. Excluded: sentence-initial common words, field labels,
 * currency codes, dates, numbers, ids, URLs.
 */
export interface EvalUnit {
  readonly file: 'XO_Com' | 'burgla' | 'Aastha';
  readonly textStart: string;
  readonly split: 'dev' | 'held';
  readonly entities: readonly string[];
}

export const EVAL_SET: readonly EvalUnit[] = [
  { file: 'XO_Com', textStart: 'Synthetic benchmark document for XO compiler/runti', split: 'dev', entities: ['XO'] },
  { file: 'XO_Com', textStart: 'Policy Form: CP-100 | Policy Period: 1 January 202', split: 'held', entities: ['India'] },
  {
    file: 'XO_Com',
    textStart: 'Named Insured: Example Manufacturing Pvt. Ltd. Pro',
    split: 'dev',
    entities: ['Example Manufacturing Pvt. Ltd.', 'Mumbai', 'Maharashtra'],
  },
  {
    file: 'burgla',
    textStart: 'DHARMISTHA KHOLIYA A 304 SHARDA GRAM MATHURADAS Na',
    split: 'dev',
    entities: ['DHARMISTHA KHOLIYA', 'VAISHNAV HOSPITAL', 'KANDIVALI WEST', 'THANE'],
  },
  {
    file: 'burgla',
    textStart: 'yashwant emerald tower yashwant emerald tower, yas',
    split: 'dev',
    entities: ['yashwant emerald tower', 'Palghar', 'Maharashtra', 'india'],
  },
  { file: 'burgla', textStart: 'Sum Insured Basis Opted Market Value', split: 'held', entities: ['Sum Insured', 'Market Value'] },
  { file: 'burgla', textStart: 'Sr. no Details Total Sum Insured (INR)', split: 'held', entities: ['Total Sum Insured'] },
  { file: 'burgla', textStart: 'Stock and Stock in Trade INR 0', split: 'dev', entities: ['Stock and Stock in Trade'] },
  { file: 'burgla', textStart: 'Good held in trust or on commission for which the', split: 'dev', entities: [] },
  {
    file: 'burgla',
    textStart: 'First Loss Sum Insured as a % of the Total Sum Ins',
    split: 'dev',
    entities: ['First Loss Sum Insured', 'Total Sum Insured'],
  },
  { file: 'burgla', textStart: '100% of the Total Sum Insured INR 450000', split: 'held', entities: ['Total Sum Insured'] },
  { file: 'burgla', textStart: 'Total Value at Risk', split: 'held', entities: ['Total Value at Risk'] },
  { file: 'burgla', textStart: 'First Loss Basis in terms of Absolute Amount', split: 'dev', entities: ['First Loss Basis'] },
  { file: 'burgla', textStart: 'Limit Opted for changing damaged locks at the entr', split: 'dev', entities: ['Voluntary deductible'] },
  { file: 'burgla', textStart: 'Any other information Sr. No Add-On Name Opted(Yes', split: 'held', entities: [] },
  {
    file: 'burgla',
    textStart: 'Clause is not Applicable for Stock Sum Insured Pur',
    split: 'held',
    entities: ['Stock Sum Insured', 'Purchase Protection'],
  },
  {
    file: 'burgla',
    textStart: 'Underinsurance Limit: Injury during Burglary /',
    split: 'dev',
    entities: ['Underinsurance Limit', 'Injury during Burglary'],
  },
  { file: 'burgla', textStart: 'Nominee Details of the Insured’s Employees (If Opt', split: 'held', entities: ['Nominee Details'] },
  { file: 'burgla', textStart: 'Terrorism cover is excluded Theft and RSMD is Excl', split: 'held', entities: ['Terrorism cover', 'RSMD'] },
  {
    file: 'burgla',
    textStart: 'For Burglary & Theft Claim, FIR and Non Traceable ',
    split: 'dev',
    entities: ['FIR', 'Non Traceable Certificate', 'Kutcha Construction Warranty'],
  },
  { file: 'burgla', textStart: 'Kutcha construction definition: Building(s) having', split: 'held', entities: ['Kutcha construction'] },
  { file: 'burgla', textStart: 'Excess: 5% of claim amount subject to minimum of I', split: 'held', entities: ['Excess'] },
  { file: 'burgla', textStart: 'CGST rate and amount (INR) 9 % 18.23', split: 'dev', entities: ['CGST'] },
  { file: 'burgla', textStart: 'IA274016654 2026-08-06 202.50 0.00 18.23 18.23 0.0', split: 'held', entities: [] },
  {
    file: 'burgla',
    textStart: 'For & On Behalf of Go Digit General Insurance Ltd.',
    split: 'dev',
    entities: [
      'Go Digit General Insurance Ltd',
      'Consolidated Stamp Duty',
      'Letter of Authorization',
      'Department of Stamps and Registration',
      'Bengaluru',
      'KARNATAKA',
    ],
  },
  { file: 'burgla', textStart: 'Hey, our document is now digitally signed. Click h', split: 'held', entities: [] },
  { file: 'burgla', textStart: 'Wish to go through your detailed policy, click her', split: 'dev', entities: ['24-Hour Call Centre'] },
  {
    file: 'Aastha',
    textStart: 'Tally Prime (Accounting). utilizing a tri-partite ',
    split: 'dev',
    entities: ['Tally Prime', 'CRM', 'Reconciliation Tool', 'Aastha Insurance Brokers Pvt Ltd'],
  },
  {
    file: 'Aastha',
    textStart: 'Note: Actual brokerage data is not stored here. CR',
    split: 'held',
    entities: ['CRM', 'Reconciliation Tool', 'Tally Prime', 'TDS', 'GST'],
  },
  { file: 'Aastha', textStart: 'nil/non-financial) are logged into the CRM. detail', split: 'dev', entities: ['CRM', 'Policy Entry'] },
  {
    file: 'Aastha',
    textStart: 'This is the core operational step where data from ',
    split: 'dev',
    entities: ['CRM', 'Policy Booked', 'Statement Collection'],
  },
  { file: 'Aastha', textStart: 'Identify "Actual" brokerage (Basic + Incentives). ', split: 'held', entities: ['Actual brokerage', 'CRM'] },
  { file: 'Aastha', textStart: 'Identify discrepancies: Policies missing from stat', split: 'dev', entities: [] },
  { file: 'Aastha', textStart: 'Match CRM records vs. Insurer statements.', split: 'dev', entities: ['CRM'] },
  {
    file: 'Aastha',
    textStart: 'Verify "Expected Brokerage" (from CRM) vs. "Actual',
    split: 'held',
    entities: ['Expected Brokerage', 'Actual Brokerage', 'CRM'],
  },
  { file: 'Aastha', textStart: 'Reconcile invoice amounts vs. receipt amounts rece', split: 'held', entities: [] },
  { file: 'Aastha', textStart: 'Validate TDS and GST figures.', split: 'held', entities: ['TDS', 'GST'] },
  {
    file: 'Aastha',
    textStart: 'deducted at the invoicing stage. the Reconciliatio',
    split: 'dev',
    entities: ['Reconciliation Tool', 'GST', 'TDS', 'Tally Prime', 'Invoicing'],
  },
  { file: 'Aastha', textStart: 'Record incoming payments (which typically include ', split: 'dev', entities: ['TDS'] },
  { file: 'Aastha', textStart: 'Reconcile the invoice balance against actual recei', split: 'held', entities: [] },
  {
    file: 'Aastha',
    textStart: 'Regulatory Reporting: Generate monthly MIS reports',
    split: 'held',
    entities: ['Regulatory Reporting', 'MIS', 'IRDAI'],
  },
  { file: 'Aastha', textStart: 'Top 10 client-wise business.', split: 'held', entities: [] },
  {
    file: 'Aastha',
    textStart: 'validated reconciliation data. Channel-wise revenu',
    split: 'held',
    entities: ['Referral', 'Digital', 'Sales', 'Associate', 'POSP'],
  },
];
