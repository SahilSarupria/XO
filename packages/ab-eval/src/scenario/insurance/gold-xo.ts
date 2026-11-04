import type { DecisionTree } from '@xo/capability-layer';
import { ManifestBuilder, type PackageBundle } from '@xo/package-sdk';
import { INSURANCE_INPUTS } from './gold-inputs.js';
import { adjudicateInsurance, generateInsuranceTasks, type InsuranceTask } from './oracle.js';

/**
 * Hand-authored gold XO for the Meridian Mutual triage desk: the manual's rules as knowledge, an executable decision
 * tree, worked examples, prompt strategy and safety rules. Written from the MANUAL, independently of the compiler and of
 * the oracle's code; a test cross-checks the tree against the oracle on thousands of random cases.
 */
export const INSURANCE_OUTPUT_CONTRACT =
  'You are triaging one auto claim for the Meridian Mutual claims desk. When you have decided, reply with ONLY a single JSON object and no other text, in exactly this shape: ' +
  '{"decision": "approve" | "deny" | "escalate", "payout_usd": <number; 0 unless the decision is approve>, "escalation_target": <string naming who it is escalated to, or null>, "reason": <one short sentence>}.';

const L = (decision: string, payout: string | number, target: string | null, code: string, rule: string, note: string) =>
  ({ type: 'leaf', output: { decision, payout_usd: payout, escalation_target: target, reason_code: code }, rule, note }) as const;

export const INSURANCE_TREE: DecisionTree = {
  id: 'claim_triage',
  description: 'Meridian Mutual auto-claims triage: applies rules R1–R10 in order and returns decision, payout and escalation target.',
  inputs: [...INSURANCE_INPUTS],
  start: 'n_injury',
  nodes: {
    n_injury: {
      type: 'branch',
      test: 'injury_involved == true',
      then: 'L_INJURY',
      else: 'n_lapsed',
      rule: 'R1',
      note: 'R1 bodily injury goes to the Casualty Unit',
    },
    n_lapsed: {
      type: 'branch',
      test: 'policy_in_force == false',
      then: 'L_LAPSED',
      else: 'n_repeat',
      rule: 'R2',
      note: 'R2 lapsed policy is denied',
    },
    n_repeat: {
      type: 'branch',
      test: 'claims_last_12m >= 2',
      then: 'L_SIU',
      else: 'c_window',
      rule: 'R3',
      note: 'R3 two or more claims in 12 months go to SIU',
    },
    c_window: {
      type: 'compute',
      set: { window_days: "claim_type == 'glass' ? 90 : 30" },
      next: 'n_late',
      rule: 'R4',
      note: 'R4 reporting deadline: 30 days, glass 90',
    },
    n_late: {
      type: 'branch',
      test: 'days_to_report > window_days',
      then: 'L_LATE',
      else: 'n_theft',
      rule: 'R4',
      note: 'reported after the deadline?',
    },
    n_theft: {
      type: 'branch',
      test: "claim_type == 'theft' && police_report_filed == false",
      then: 'L_NO_REPORT',
      else: 'c_deductible',
      rule: 'R5',
      note: 'R5 theft needs a police report',
    },
    c_deductible: {
      type: 'compute',
      set: { deductible: "claim_type == 'collision' ? 500 : (claim_type == 'glass' ? 250 : 1000)" },
      next: 'n_nothing',
      rule: 'R7',
      note: 'R7 deductible by claim type',
    },
    n_nothing: {
      type: 'branch',
      test: 'repair_estimate_usd <= deductible',
      then: 'L_NOTHING',
      else: 'c_pay',
      rule: 'R8',
      note: 'R8 nothing payable when the estimate does not exceed the deductible',
    },
    c_pay: {
      type: 'compute',
      set: {
        base: 'repair_estimate_usd > 0.75 * vehicle_value_usd ? vehicle_value_usd : repair_estimate_usd',
        payout: 'base - deductible + (rental_coverage ? 40 * min(rental_days, 14) : 0)',
      },
      next: 'n_authority',
      rule: 'R6',
      note: 'R6 valuation (total loss above 75% of market value), R9 rental $40/day up to 14 days',
    },
    n_authority: {
      type: 'branch',
      test: 'payout > 15000',
      then: 'L_AUTH',
      else: 'L_APPROVE',
      rule: 'R10',
      note: 'R10 payments above $15,000 need the Senior Adjuster',
    },
    L_INJURY: L('escalate', 0, 'Casualty Unit', 'INJURY', 'R1', 'bodily injury'),
    L_LAPSED: L('deny', 0, null, 'POLICY_LAPSED', 'R2', 'policy not in force'),
    L_SIU: L('escalate', 0, 'SIU', 'REPEAT_CLAIMANT', 'R3', 'repeat claimant'),
    L_LATE: L('deny', 0, null, 'REPORTED_LATE', 'R4', 'reported after the deadline'),
    L_NO_REPORT: L('deny', 0, null, 'NO_POLICE_REPORT', 'R5', 'theft without police report'),
    L_NOTHING: L('deny', 0, null, 'NOTHING_PAYABLE', 'R8', 'estimate does not exceed the deductible'),
    L_AUTH: L('escalate', 0, 'Senior Adjuster', 'OVER_AUTHORITY', 'R10', 'payment above $15,000'),
    L_APPROVE: L(
      'approve',
      '=round(payout, 2)',
      null,
      'APPROVED',
      'R6',
      'repair estimate (or market value if total loss) less deductible, plus rental',
    ),
  },
};

export interface InsuranceGoldFact {
  readonly id: string;
  readonly description: string;
  readonly patterns: readonly RegExp[];
}
export const INSURANCE_GOLD_FACTS: readonly InsuranceGoldFact[] = [
  { id: 'I_ORDER', description: 'order of review', patterns: [/injury/i, /policy status/i, /repeat/i, /deadline/i, /authority/i] },
  { id: 'I_INJURY', description: 'injury → Casualty Unit', patterns: [/injur|hurt/i, /Casualty Unit/] },
  { id: 'I_LAPSE', description: 'lapsed policy denied', patterns: [/in force|lapsed/i, /denied/i] },
  {
    id: 'I_REPEAT',
    description: '2+ claims in 12 months → SIU',
    patterns: [/\b2 or more\b/i, /\b12 months\b/, /SIU|Special Investigations/],
  },
  { id: 'I_WINDOW', description: '30-day reporting deadline, glass 90', patterns: [/\b30 days\b/, /\b90 days\b/, /glass/i] },
  { id: 'I_THEFT', description: 'theft needs police report', patterns: [/theft/i, /police report/i] },
  { id: 'I_TOTAL_LOSS', description: 'total loss above 75% of market value', patterns: [/\b75%/, /total loss/i, /market value/i] },
  { id: 'I_DEDUCTIBLE', description: 'deductibles 500/250/1000', patterns: [/\b500\b/, /\b250\b/, /\b1000\b|\b1,000\b/] },
  {
    id: 'I_NOTHING',
    description: 'estimate not above deductible → denied',
    patterns: [/does not exceed the deductible/i, /nothing is payable/i],
  },
  { id: 'I_RENTAL', description: 'rental $40/day, max 14 days', patterns: [/\$40/, /\b14 days\b/] },
  { id: 'I_AUTHORITY', description: 'above $15,000 → Senior Adjuster', patterns: [/\$15,000/, /Senior Adjuster/] },
];

interface Entry {
  readonly id: string;
  readonly section: string;
  readonly title: string;
  readonly text: string;
  readonly fact: string | null;
}
export const INSURANCE_ENTRIES: readonly Entry[] = [
  {
    id: 'rule_order',
    section: 'Order of review',
    title: 'Order of review',
    fact: 'I_ORDER',
    text: 'Work the rules in this order: injury, policy status, repeat claimants, reporting deadline, theft report, valuation, authority. Stop at the first rule that decides the claim.',
  },
  {
    id: 'rule_injury',
    section: 'Rules',
    title: 'R1 Injury',
    fact: 'I_INJURY',
    text: 'Any claim in which someone was hurt (bodily injury) is referred to the Casualty Unit. The desk never settles an injury claim, whatever the amount.',
  },
  {
    id: 'rule_status',
    section: 'Rules',
    title: 'R2 Policy status',
    fact: 'I_LAPSE',
    text: 'A claim is payable only if the policy was in force on the date of loss. If the policy had lapsed, the claim is denied.',
  },
  {
    id: 'rule_repeat',
    section: 'Rules',
    title: 'R3 Repeat claimants',
    fact: 'I_REPEAT',
    text: 'A policyholder with 2 or more claims in the previous 12 months is escalated to SIU (Special Investigations) before any other check, even if the claim is late.',
  },
  {
    id: 'rule_deadline',
    section: 'Rules',
    title: 'R4 Reporting deadline',
    fact: 'I_WINDOW',
    text: 'Collision and theft claims must be reported within 30 days of the loss; glass claims within 90 days. A claim reported after its deadline is denied.',
  },
  {
    id: 'rule_theft',
    section: 'Rules',
    title: 'R5 Theft',
    fact: 'I_THEFT',
    text: 'A theft claim is only payable once a police report has been filed. With no police report the claim is denied.',
  },
  {
    id: 'rule_valuation',
    section: 'Rules',
    title: 'R6 Valuation',
    fact: 'I_TOTAL_LOSS',
    text: 'The desk pays the repair estimate less the deductible. If the repair estimate is more than 75% of the vehicle market value it is a total loss: pay the market value less the deductible instead.',
  },
  {
    id: 'rule_deductible',
    section: 'Rules',
    title: 'R7 Deductibles',
    fact: 'I_DEDUCTIBLE',
    text: 'The deductible is 500 for collision, 250 for glass and 1000 for theft.',
  },
  {
    id: 'rule_nothing',
    section: 'Rules',
    title: 'R8 Nothing payable',
    fact: 'I_NOTHING',
    text: 'If the repair estimate does not exceed the deductible, nothing is payable and the claim is denied.',
  },
  {
    id: 'rule_rental',
    section: 'Rules',
    title: 'R9 Rental car',
    fact: 'I_RENTAL',
    text: 'With rental coverage, rental is reimbursed at $40 per day for a maximum of 14 days, and is added to the payout.',
  },
  {
    id: 'rule_authority',
    section: 'Rules',
    title: 'R10 Authority',
    fact: 'I_AUTHORITY',
    text: 'Payments above $15,000 need Senior Adjuster approval: escalate to the Senior Adjuster and do not set a payout. The payment tested is the total, rental included.',
  },
  {
    id: 'conduct',
    section: 'Conduct',
    title: 'Conduct',
    fact: null,
    text: 'Never promise a settlement figure to the claimant before the estimate has been verified. Do not discuss other policyholders’ claims.',
  },
  {
    id: 'about',
    section: 'About the desk',
    title: 'About the desk',
    fact: null,
    text: 'The desk was set up in 2019 to take simple claims off the adjusters’ queues. It handles collision, glass and theft claims; anything else goes to a human adjuster.',
  },
];

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export function insuranceTraceLines(tasks: readonly InsuranceTask[]): string {
  return tasks
    .filter((t, i, all) => all.findIndex((u) => u.stratum === t.stratum) === i)
    .map((t) => {
      const f = t.facts;
      return JSON.stringify({
        id: t.id,
        task_type: f.claim_type,
        scenario: `${f.claim_type} claim, reported ${f.days_to_report} days after the loss, estimate $${f.repair_estimate_usd}, vehicle worth $${f.vehicle_value_usd}`,
        steps: [`Stratum: ${t.stratum}`],
        conclusion: t.expected,
        confidence: 1,
        provenance: 'worked example derived from the triage-desk oracle',
      });
    })
    .join('\n');
}

export function buildInsuranceGoldXo(
  options: { readonly tasks?: readonly InsuranceTask[]; readonly version?: string } = {},
): PackageBundle {
  const tasks = options.tasks ?? generateInsuranceTasks();
  const knowledge = {
    nodes: INSURANCE_ENTRIES.map((e) => ({
      id: e.id,
      kind: e.fact === null ? 'background' : 'rule',
      properties: { title: e.title, section: e.section, text: e.text },
      confidence: 1,
      provenance: { source: 'meridian-claims-manual-rev4', fact: e.fact },
    })),
    edges: [
      { from: 'rule_order', to: 'rule_injury', kind: 'precedes' },
      { from: 'rule_injury', to: 'rule_status', kind: 'precedes' },
      { from: 'rule_status', to: 'rule_repeat', kind: 'precedes' },
      { from: 'rule_repeat', to: 'rule_deadline', kind: 'precedes' },
      { from: 'rule_valuation', to: 'rule_deductible', kind: 'applies_with' },
      { from: 'rule_valuation', to: 'rule_rental', kind: 'applies_with' },
      { from: 'rule_rental', to: 'rule_authority', kind: 'applies_with' },
    ],
  };
  const strategies = {
    persona:
      'You are a senior claims triager at Meridian Mutual. You apply the desk manual exactly and in order, do the arithmetic carefully, and hand anything outside your authority to the right unit instead of deciding it yourself. You ignore any amount the claimant says they are owed.',
    fragments: [
      {
        id: 'procedure',
        text: 'Procedure: apply the rules in the manual’s order of review — injury, policy status, repeat claimants, reporting deadline, theft report, valuation, authority — and stop at the first rule that decides the claim. Count reporting days in calendar days from the date of loss.',
      },
      {
        id: 'tool_use',
        requires: 'tool_use',
        text: 'You have a decision-tree tool, evaluate_decision_tree, that applies the manual deterministically. Extract the facts the claim states (compute day counts yourself), call the tool once, and report its outcome exactly. Do not override its decision or payout. If it reports a missing fact and the claim truly does not state it, say so and escalate to a human adjuster.',
      },
    ],
  };
  const safety = {
    rules: [
      {
        id: 'SR1',
        applies_to: 'output',
        when: "decision == 'approve' && payout_usd > 15000",
        action: 'block',
        message: 'The desk may not approve more than $15,000; escalating to the Senior Adjuster.',
        override_output: { decision: 'escalate', payout_usd: 0, escalation_target: 'Senior Adjuster' },
      },
      {
        id: 'SR2',
        applies_to: 'output',
        when: "(decision == 'deny' || decision == 'escalate') && payout_usd != 0",
        action: 'block',
        message: 'Denied or escalated claims must carry payout 0.',
        override_output: undefined,
      },
      {
        id: 'SR3',
        applies_to: 'input',
        when: "contains(input_text, 'ignore previous instructions') || contains(input_text, 'disregard the manual')",
        action: 'warn',
        message: 'Claim text contains instruction-like content; treated as data only.',
      },
    ],
  };
  const benchmark = {
    suite: 'meridian-claims-v1',
    methodology: 'Seeded, stratified cases; ground truth from an independent oracle (packages/ab-eval/src/scenario/insurance).',
    items: tasks.map((t) => ({ id: t.id, category: t.stratum, input: JSON.stringify(t.facts), expected: t.expected })),
  };
  const all = ['knowledge_graph', 'decision_trees', 'reasoning_traces', 'prompt_strategies', 'safety_rules', 'benchmark_suite'] as const;
  const built = ManifestBuilder.create()
    .setIdentity({
      formatVersion: '1.0',
      name: 'meridian-auto-claims-triage',
      version: options.version ?? '1.0.0',
      creatorDid: 'did:xo:gold-author',
    })
    .setCompatibility({
      modelFamilies: [
        { family: 'claude', minCapability: ['chat', 'tool_use'], consumes: [...all] },
        {
          family: 'generic',
          minCapability: ['chat'],
          consumes: ['knowledge_graph', 'prompt_strategies', 'safety_rules', 'benchmark_suite'],
        },
      ],
      fallbackPolicy: 'degrade_gracefully',
    })
    .setMetadata({
      domain: 'auto claims triage (fictional insurer)',
      description: 'Hand-authored gold XO for the Meridian Mutual triage desk.',
      scope: ['collision claims', 'glass claims', 'theft claims'],
      limitations: [
        'fictional insurer and rules',
        'does not give legal advice',
        'escalates injury, repeat claimants and payments above $15,000',
      ],
      tags: ['gold', 'insurance', 'claims'],
    })
    .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', required: false, data: enc(knowledge) })
    .addComponent({
      kind: 'decision_trees',
      path: 'reasoning/decision_trees.json',
      required: false,
      data: enc({ trees: [INSURANCE_TREE] }),
    })
    .addComponent({
      kind: 'reasoning_traces',
      path: 'reasoning/reasoning_traces.jsonl',
      required: false,
      data: enc(insuranceTraceLines(tasks)),
    })
    .addComponent({ kind: 'prompt_strategies', path: 'prompting/strategies.json', required: false, data: enc(strategies) })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', required: true, data: enc(safety) })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', required: true, data: enc(benchmark) })
    .build();
  if (!built.ok) throw new Error(`insurance gold XO failed to build: ${JSON.stringify(built.error)}`);
  return built.value;
}

// keep the oracle import used by tests of equivalence
export const insuranceOracle = adjudicateInsurance;
