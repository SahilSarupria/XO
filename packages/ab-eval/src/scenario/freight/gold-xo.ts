import type { DecisionTree } from '@xo/capability-layer';
import { ManifestBuilder, type PackageBundle } from '@xo/package-sdk';
import { generateEvalTasks, generateExemplarTasks, type FreightTask } from './generate.js';
import { adjudicate } from './oracle.js';
import { DEFAULT_HANDBOOK_SIZE, knowledgeNodeEntries } from './rules.js';

/** Identical in every arm: it fixes the answer *format* only and carries no house knowledge. */
export const OUTPUT_CONTRACT =
  'You are adjudicating one freight claim for the Halvorsen Freight claims desk. When you have decided, reply with ONLY a single JSON object and no other text, in exactly this shape: ' +
  '{"decision": "approve" | "partial" | "deny" | "escalate", "payout_usd": <number; 0 unless the decision is approve or partial>, "escalation_target": <string naming who it is escalated to, or null>, "reason": <one short sentence>}.';

const L = (decision: string, payout: string | number, target: string | null, code: string, rule: string, note: string) =>
  ({ type: 'leaf', output: { decision, payout_usd: payout, escalation_target: target, reason_code: code }, rule, note }) as const;

export const FREIGHT_TREE: DecisionTree = {
  id: 'claim_adjudication',
  description: 'Halvorsen claims-desk adjudication: applies rules R1–R6 in order and returns decision, payout and escalation target.',
  inputs: [
    { name: 'claim_type', type: 'string', enum: ['damage', 'loss', 'delay', 'temperature'], description: 'kind of claim' },
    {
      name: 'commodity_class',
      type: 'string',
      enum: ['general', 'electronics', 'fragile_glass', 'perishable', 'hazmat'],
      description: 'TMS commodity class of the freight',
    },
    {
      name: 'claimant_claims_last_90d',
      type: 'number',
      description: 'number of earlier claims by this claimant in the previous 90 days (0 if none)',
    },
    {
      name: 'days_to_file',
      type: 'number',
      description:
        'calendar days from the event date to the filing date; event date = delivery date (damage, delay, temperature) or the scheduled delivery date (loss)',
    },
    {
      name: 'pod_damage_noted',
      type: 'boolean',
      description: 'damage claims: true if the consignee noted the damage on the proof of delivery',
    },
    {
      name: 'packaging',
      type: 'string',
      enum: ['carrier_packed', 'shipper_adequate', 'shipper_inadequate'],
      description: 'damage claims: who packed the freight and whether the packaging was adequate',
    },
    { name: 'weight_lb', type: 'number', description: 'weight in pounds of the affected goods' },
    { name: 'declared_value_usd', type: 'number', description: 'declared value of the affected goods in USD; 0 if no value was declared' },
    { name: 'full_value_coverage', type: 'boolean', description: 'true if a Full Value Coverage endorsement is on the bill of lading' },
    { name: 'damage_pct', type: 'number', description: 'damage claims: percent of the affected goods that are damaged (0–100)' },
    { name: 'salvage_value_usd', type: 'number', description: 'damage claims: salvage offer in USD; 0 if none' },
    { name: 'days_late', type: 'number', description: 'delay claims: days between the scheduled and the actual delivery date' },
    { name: 'weather_event', type: 'boolean', description: 'delay claims: true if the delay was caused by a documented weather event' },
    { name: 'reefer_log_available', type: 'boolean', description: 'temperature claims: true if a reefer temperature log is available' },
    {
      name: 'excursion_hours',
      type: 'number',
      description: 'temperature claims: hours the trailer ran above its set temperature (only when a log is available)',
    },
  ],
  start: 'n_hazmat',
  nodes: {
    n_hazmat: {
      type: 'branch',
      test: "commodity_class == 'hazmat'",
      then: 'L_HAZMAT',
      else: 'n_fraud',
      rule: 'R1',
      note: 'R1 hazmat check',
    },
    n_fraud: {
      type: 'branch',
      test: 'claimant_claims_last_90d >= 3',
      then: 'L_FRAUD',
      else: 'c_window',
      rule: 'R2',
      note: 'R2 fraud screen (3+ claims in 90 days)',
    },
    c_window: {
      type: 'compute',
      set: {
        window_days: "claim_type == 'damage' ? (pod_damage_noted ? 30 : 9) : (claim_type == 'loss' ? 60 : (claim_type == 'delay' ? 5 : 4))",
      },
      next: 'n_late',
      rule: 'R3',
      note: 'R3 filing window',
    },
    n_late: {
      type: 'branch',
      test: 'days_to_file > window_days',
      then: 'L_WINDOW',
      else: 'n_is_delay',
      rule: 'R3',
      note: 'filed after window?',
    },
    n_is_delay: { type: 'branch', test: "claim_type == 'delay'", then: 'n_weather', else: 'n_is_temp', rule: 'R4' },
    n_weather: {
      type: 'branch',
      test: 'weather_event == true',
      then: 'n_weather_min',
      else: 'n_delay_min',
      rule: 'R4',
      note: 'weather event?',
    },
    n_weather_min: {
      type: 'branch',
      test: 'days_late <= 3',
      then: 'L_WEATHER',
      else: 'c_delay_w',
      rule: 'R4',
      note: 'weather delay of 3 days or less',
    },
    c_delay_w: {
      type: 'compute',
      set: { comp_days: 'min(days_late - 3, 5)' },
      next: 'L_DELAY_PAID',
      rule: 'R4',
      note: 'compensable days beyond the first 3, max 5',
    },
    n_delay_min: { type: 'branch', test: 'days_late < 2', then: 'L_MIN_DELAY', else: 'c_delay_n', rule: 'R4', note: 'delay under 2 days' },
    c_delay_n: {
      type: 'compute',
      set: { comp_days: 'min(days_late, 5)' },
      next: 'L_DELAY_PAID',
      rule: 'R4',
      note: 'compensable days, max 5',
    },
    L_DELAY_PAID: {
      type: 'leaf',
      output: { decision: 'approve', payout_usd: '=round(85 * comp_days, 2)', escalation_target: null, reason_code: 'DELAY_PAID' },
      rule: 'R4',
      note: '$85 per compensable day',
    },
    n_is_temp: { type: 'branch', test: "claim_type == 'temperature'", then: 'n_temp_class', else: 'n_is_damage', rule: 'R4' },
    n_temp_class: {
      type: 'branch',
      test: "commodity_class != 'perishable'",
      then: 'L_NOT_TEMP',
      else: 'n_temp_log',
      rule: 'R4',
      note: 'perishable freight only',
    },
    n_temp_log: {
      type: 'branch',
      test: 'reefer_log_available == false',
      then: 'L_NO_LOG',
      else: 'n_temp_exc',
      rule: 'R4',
      note: 'reefer log available?',
    },
    n_temp_exc: {
      type: 'branch',
      test: 'excursion_hours <= 6',
      then: 'L_TOLERANCE',
      else: 'c_temp',
      rule: 'R4',
      note: 'excursion within 6-hour tolerance?',
    },
    c_temp: {
      type: 'compute',
      set: { pct_eff: '100', salvage_eff: '0' },
      next: 'c_calc',
      rule: 'R4',
      note: 'temperature claim paid as total loss',
    },
    n_is_damage: { type: 'branch', test: "claim_type == 'damage'", then: 'n_pack', else: 'c_loss', rule: 'R4' },
    n_pack: {
      type: 'branch',
      test: "packaging == 'shipper_inadequate'",
      then: 'L_PACKAGING',
      else: 'c_dmg',
      rule: 'R4',
      note: 'inadequate shipper packaging?',
    },
    c_dmg: { type: 'compute', set: { pct_eff: 'damage_pct', salvage_eff: 'salvage_value_usd' }, next: 'c_calc', rule: 'R4' },
    c_loss: { type: 'compute', set: { pct_eff: '100', salvage_eff: '0' }, next: 'c_calc', rule: 'R4', note: 'loss treated as 100% damage' },
    c_calc: {
      type: 'compute',
      rule: 'R5',
      note: 'payout calculation',
      set: {
        rate: "commodity_class == 'electronics' ? 4 : (commodity_class == 'fragile_glass' ? 1.75 : 2.5)",
        cap: 'weight_lb * rate',
        base: 'full_value_coverage == true ? declared_value_usd : (declared_value_usd > 0 ? min(declared_value_usd, cap) : cap)',
        gross: 'base * pct_eff / 100',
        net: 'gross - salvage_eff',
        deductible: 'full_value_coverage == true ? 0 : 150',
        payout_calc: 'net - deductible',
      },
      next: 'n_net',
    },
    n_net: { type: 'branch', test: 'net <= 0', then: 'L_NO_NET', else: 'n_ded', rule: 'R5', note: 'any net loss left after salvage?' },
    n_ded: {
      type: 'branch',
      test: 'payout_calc <= 0',
      then: 'L_BELOW_DED',
      else: 'n_mgr',
      rule: 'R5',
      note: 'net loss exceeds deductible?',
    },
    n_mgr: {
      type: 'branch',
      test: 'payout_calc > 25000',
      then: 'L_MANAGER',
      else: 'n_partial',
      rule: 'R6',
      note: 'payout above $25,000 authority?',
    },
    n_partial: { type: 'branch', test: "claim_type == 'damage' && pct_eff < 100", then: 'L_PARTIAL', else: 'L_PAID', rule: 'R5' },
    L_PARTIAL: {
      type: 'leaf',
      output: { decision: 'partial', payout_usd: '=round(payout_calc, 2)', escalation_target: null, reason_code: 'DAMAGE_PARTIAL' },
      rule: 'R5',
      note: 'partial settlement',
    },
    L_PAID: {
      type: 'leaf',
      output: { decision: 'approve', payout_usd: '=round(payout_calc, 2)', escalation_target: null, reason_code: 'PAID' },
      rule: 'R5',
      note: 'approved',
    },
    L_HAZMAT: L('escalate', 0, 'Hazmat Compliance', 'HAZMAT', 'R1', 'hazmat → Hazmat Compliance'),
    L_FRAUD: L('escalate', 0, 'SIU', 'FRAUD_SCREEN', 'R2', 'fraud screen → SIU'),
    L_WINDOW: L('deny', 0, null, 'FILING_WINDOW', 'R3', 'filed too late'),
    L_WEATHER: L('deny', 0, null, 'WEATHER', 'R4', 'weather delay within the excluded first 3 days'),
    L_MIN_DELAY: L('deny', 0, null, 'MIN_DELAY', 'R4', 'delay under 2 days'),
    L_NOT_TEMP: L('deny', 0, null, 'NOT_TEMP_SENSITIVE', 'R4', 'freight is not perishable'),
    L_NO_LOG: L('escalate', 0, 'Cold Chain Desk', 'NO_REEFER_LOG', 'R4', 'no reefer log → Cold Chain Desk'),
    L_TOLERANCE: L('deny', 0, null, 'WITHIN_TOLERANCE', 'R4', 'excursion within tolerance'),
    L_PACKAGING: L('deny', 0, null, 'PACKAGING', 'R4', 'inadequate shipper packaging'),
    L_NO_NET: L('deny', 0, null, 'NO_NET_LOSS', 'R5', 'salvage covers the loss'),
    L_BELOW_DED: L('deny', 0, null, 'BELOW_DEDUCTIBLE', 'R5', 'net loss does not exceed deductible'),
    L_MANAGER: L('escalate', 0, 'Claims Manager', 'MANAGER_THRESHOLD', 'R6', 'payout above authority → Claims Manager'),
  } as DecisionTree['nodes'],
};

const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export function exemplarTraceLines(exemplars: readonly FreightTask[] = generateExemplarTasks()): string {
  return exemplars
    .map((t) => {
      const o = adjudicate(t.facts);
      return JSON.stringify({
        id: t.id,
        task_type: t.facts.claim_type,
        scenario: t.narrative,
        steps: o.steps,
        conclusion: { decision: o.decision, payout_usd: o.payout_usd, escalation_target: o.escalation_target },
        confidence: 1,
        provenance: 'worked example derived from the claims-desk oracle',
      });
    })
    .join('\n');
}

export interface GoldXoOptions {
  readonly tasks?: readonly FreightTask[];
  readonly version?: string;
  /** Number of filler operations-handbook entries alongside the claims rules. */
  readonly handbook?: number;
}

export function buildGoldXo(options: GoldXoOptions = {}): PackageBundle {
  const tasks = options.tasks ?? generateEvalTasks();
  const knowledge = {
    nodes: knowledgeNodeEntries(options.handbook ?? DEFAULT_HANDBOOK_SIZE).map((e) => ({
      id: e.id,
      kind: e.factId === null ? 'background' : 'rule',
      ...(e.pinned === true ? { pinned: true } : {}),
      properties: { title: e.title, section: e.section, text: e.text, ...(e.keywords !== undefined ? { keywords: e.keywords } : {}) },
      confidence: 1,
      provenance: { source: 'halvorsen-claims-manual-rev7', fact: e.factId },
    })),
    edges: [
      { from: 'rule_order', to: 'rule_hazmat', kind: 'precedes' },
      { from: 'rule_hazmat', to: 'rule_fraud', kind: 'precedes' },
      { from: 'rule_fraud', to: 'rule_windows', kind: 'precedes' },
      // rules that are always applied together
      { from: 'rule_rates', to: 'rule_base', kind: 'applies_with' },
      { from: 'rule_base', to: 'rule_deductible', kind: 'applies_with' },
      { from: 'rule_rates', to: 'rule_deductible', kind: 'applies_with' },
      { from: 'rule_delay_min', to: 'rule_delay_weather', kind: 'applies_with' },
      { from: 'rule_delay_weather', to: 'rule_delay_pay', kind: 'applies_with' },
      { from: 'rule_delay_min', to: 'rule_delay_pay', kind: 'applies_with' },
    ],
  };
  const strategies = {
    persona:
      'You are a senior claims adjudicator at Halvorsen Freight with years of experience on this desk. You apply the house manual exactly and in order, you do the arithmetic carefully, and you hand anything outside your authority to the right specialist instead of deciding it yourself. You ignore the amount a claimant says they are owed.',
    fragments: [
      {
        id: 'procedure',
        text: 'Procedure: apply the rules in the manual’s order of review — hazmat, fraud screen, filing window, claim-type exclusions, payout calculation, manager threshold — and stop at the first rule that decides the claim. Count filing days in calendar days from the event date.',
      },
      {
        id: 'tool_use',
        requires: 'tool_use',
        text: 'You have a decision-tree tool, evaluate_decision_tree, that applies the manual deterministically. Extract the facts the claim states (compute day counts from the dates yourself), call the tool once, and report its outcome exactly. Do not override the tool’s decision or payout. If it reports a missing fact, re-read the claim and call again; if the claim truly does not state it, say so and escalate to the Claims Manager.',
      },
    ],
  };
  const safety = {
    rules: [
      {
        id: 'SR1',
        applies_to: 'output',
        when: "(decision == 'approve' || decision == 'partial') && payout_usd > 25000",
        action: 'block',
        message: 'The desk may not approve more than $25,000; escalating to the Claims Manager.',
        override_output: { decision: 'escalate', payout_usd: 0, escalation_target: 'Claims Manager' },
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
    suite: 'halvorsen-claims-v1',
    methodology:
      'Seeded, stratified claims; ground truth from an independent oracle (see packages/ab-eval). Items are never exposed to the model by the capability layer.',
    items: tasks.map((t) => ({ id: t.id, category: t.stratum, input: t.narrative, expected: t.expected, factsUsed: t.factsUsed })),
  };
  const all = ['knowledge_graph', 'decision_trees', 'reasoning_traces', 'prompt_strategies', 'safety_rules', 'benchmark_suite'] as const;
  const built = ManifestBuilder.create()
    .setIdentity({
      formatVersion: '1.0',
      name: 'halvorsen-freight-claims-desk',
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
      domain: 'freight claims adjudication (fictional carrier)',
      description:
        'Hand-authored gold XO for the Halvorsen Freight claims desk: house rules as knowledge, an executable decision tree, worked examples, prompt strategy and safety rules.',
      scope: ['cargo damage claims', 'cargo loss claims', 'delay claims', 'temperature claims'],
      limitations: [
        'fictional carrier and rules',
        'does not give legal advice',
        'escalates anything above $25,000, hazmat or suspected fraud',
      ],
      tags: ['gold', 'freight', 'claims'],
    })
    .addComponent({ kind: 'knowledge_graph', path: 'knowledge/graph.json', required: false, data: enc(knowledge) })
    .addComponent({ kind: 'decision_trees', path: 'reasoning/decision_trees.json', required: false, data: enc({ trees: [FREIGHT_TREE] }) })
    .addComponent({ kind: 'reasoning_traces', path: 'reasoning/reasoning_traces.jsonl', required: false, data: enc(exemplarTraceLines()) })
    .addComponent({ kind: 'prompt_strategies', path: 'prompting/strategies.json', required: false, data: enc(strategies) })
    .addComponent({ kind: 'safety_rules', path: 'safety/rules.json', required: true, data: enc(safety) })
    .addComponent({ kind: 'benchmark_suite', path: 'evaluation/benchmark_suite.json', required: true, data: enc(benchmark) })
    .build();
  if (!built.ok) throw new Error(`gold XO failed to build: ${JSON.stringify(built.error)}`);
  return built.value;
}
