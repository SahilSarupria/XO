import type { ClaimFacts, Outcome } from './facts.js';
import { adjudicate } from './oracle.js';
import { chance, makeRng, pick, renderClaim, renderClaimVariant, ri, type Rng } from './render.js';

export type TaskStyle = 'standard' | 'variant';

export interface FreightTask {
  readonly id: string;
  readonly stratum: string;
  readonly narrative: string;
  /** What a structured intake form for the same claim carries (for the deterministic path). */
  readonly statedFacts: Partial<ClaimFacts>;
  readonly facts: ClaimFacts;
  readonly expected: Pick<Outcome, 'decision' | 'payout_usd' | 'escalation_target' | 'reason_code'>;
  readonly factsUsed: readonly string[];
}

function baseFacts(r: Rng): ClaimFacts {
  return {
    claim_type: 'damage',
    commodity_class: pick(r, ['general', 'electronics', 'fragile_glass', 'general'] as const),
    claimant_claims_last_90d: ri(r, 0, 2),
    days_to_file: ri(r, 1, 7),
    pod_damage_noted: chance(r, 0.3),
    packaging: pick(r, ['carrier_packed', 'shipper_adequate'] as const),
    weight_lb: ri(r, 10, 160) * 10,
    declared_value_usd: chance(r, 0.6) ? ri(r, 5, 80) * 100 : 0,
    full_value_coverage: chance(r, 0.25),
    damage_pct: ri(r, 2, 18) * 5,
    salvage_value_usd: chance(r, 0.4) ? ri(r, 1, 30) * 10 : 0,
    days_late: 0,
    weather_event: false,
    reefer_log_available: true,
    excursion_hours: 0,
  };
}

type Gen = (r: Rng) => { facts: ClaimFacts; codes: string[] };
const G =
  (f: (r: Rng) => Partial<ClaimFacts>, ...codes: string[]): Gen =>
  (r) => ({ facts: { ...baseFacts(r), ...f(r) }, codes });

const STRATA: Record<string, Gen> = {
  HAZMAT: G(
    (r) => ({
      claim_type: pick(r, ['damage', 'loss', 'delay', 'temperature'] as const),
      commodity_class: 'hazmat',
      days_to_file: ri(r, 1, 40),
      claimant_claims_last_90d: ri(r, 0, 5),
    }),
    'HAZMAT',
  ),
  FRAUD_SCREEN: G(
    (r) => ({
      claim_type: pick(r, ['damage', 'loss', 'delay'] as const),
      claimant_claims_last_90d: ri(r, 3, 7),
      days_to_file: ri(r, 1, 40),
      packaging: pick(r, ['shipper_inadequate', 'carrier_packed'] as const),
    }),
    'FRAUD_SCREEN',
  ),
  FILING_DAMAGE: G((r) => ({ claim_type: 'damage', pod_damage_noted: false, days_to_file: ri(r, 10, 28) }), 'FILING_WINDOW'),
  POD_EXTENDED: G(
    (r) => ({
      claim_type: 'damage',
      pod_damage_noted: true,
      days_to_file: ri(r, 10, 30),
      packaging: 'carrier_packed',
      damage_pct: ri(r, 6, 20) * 5,
      declared_value_usd: ri(r, 20, 90) * 100,
      weight_lb: ri(r, 80, 300) * 10,
      salvage_value_usd: 0,
    }),
    'DAMAGE_PARTIAL',
    'PAID',
  ),
  FILING_OTHER: (r) => {
    const t = pick(r, ['delay', 'loss', 'temperature'] as const);
    const f = baseFacts(r);
    const late = t === 'delay' ? ri(r, 6, 14) : t === 'loss' ? ri(r, 61, 90) : ri(r, 5, 12);
    return {
      facts: {
        ...f,
        claim_type: t,
        days_to_file: late,
        days_late: ri(r, 2, 6),
        commodity_class: t === 'temperature' ? 'perishable' : f.commodity_class,
        excursion_hours: 12,
      },
      codes: ['FILING_WINDOW'],
    };
  },
  PACKAGING: G(() => ({ claim_type: 'damage', packaging: 'shipper_inadequate', days_to_file: 3 }), 'PACKAGING'),
  WEATHER_DENY: G((r) => ({ claim_type: 'delay', weather_event: true, days_late: ri(r, 1, 3), days_to_file: ri(r, 0, 5) }), 'WEATHER'),
  WEATHER_PAID: G((r) => ({ claim_type: 'delay', weather_event: true, days_late: ri(r, 4, 9), days_to_file: ri(r, 0, 5) }), 'DELAY_PAID'),
  MIN_DELAY: G((r) => ({ claim_type: 'delay', weather_event: false, days_late: 1, days_to_file: ri(r, 0, 5) }), 'MIN_DELAY'),
  DELAY_PAID: G((r) => ({ claim_type: 'delay', weather_event: false, days_late: ri(r, 2, 9), days_to_file: ri(r, 0, 5) }), 'DELAY_PAID'),
  TEMP_NOT_SENSITIVE: G(
    (r) => ({
      claim_type: 'temperature',
      commodity_class: pick(r, ['general', 'electronics'] as const),
      days_to_file: ri(r, 0, 4),
      excursion_hours: ri(r, 8, 20),
    }),
    'NOT_TEMP_SENSITIVE',
  ),
  TEMP_NO_LOG: G(
    (r) => ({ claim_type: 'temperature', commodity_class: 'perishable', reefer_log_available: false, days_to_file: ri(r, 0, 4) }),
    'NO_REEFER_LOG',
  ),
  TEMP_TOLERANCE: G(
    (r) => ({ claim_type: 'temperature', commodity_class: 'perishable', excursion_hours: ri(r, 2, 6), days_to_file: ri(r, 0, 4) }),
    'WITHIN_TOLERANCE',
  ),
  TEMP_PAID: G(
    (r) => ({
      claim_type: 'temperature',
      commodity_class: 'perishable',
      excursion_hours: ri(r, 7, 30),
      days_to_file: ri(r, 0, 4),
      weight_lb: ri(r, 100, 800) * 10,
      declared_value_usd: chance(r, 0.7) ? ri(r, 30, 150) * 100 : 0,
    }),
    'PAID',
  ),
  DAMAGE_PARTIAL: G(
    (r) => ({
      claim_type: 'damage',
      pod_damage_noted: false,
      days_to_file: ri(r, 1, 9),
      packaging: pick(r, ['carrier_packed', 'shipper_adequate'] as const),
      damage_pct: ri(r, 3, 17) * 5,
      weight_lb: ri(r, 100, 500) * 10,
      declared_value_usd: ri(r, 40, 160) * 100,
      salvage_value_usd: ri(r, 0, 20) * 10,
    }),
    'DAMAGE_PARTIAL',
  ),
  DAMAGE_FULL: G(
    (r) => ({
      claim_type: 'damage',
      days_to_file: ri(r, 1, 9),
      packaging: 'carrier_packed',
      damage_pct: 100,
      weight_lb: ri(r, 100, 500) * 10,
      declared_value_usd: ri(r, 40, 160) * 100,
      salvage_value_usd: 0,
    }),
    'PAID',
  ),
  LOSS_PAID: G(
    (r) => ({
      claim_type: 'loss',
      days_to_file: ri(r, 5, 60),
      weight_lb: ri(r, 100, 600) * 10,
      declared_value_usd: chance(r, 0.7) ? ri(r, 30, 150) * 100 : 0,
    }),
    'PAID',
  ),
  BELOW_DEDUCTIBLE: G(
    (r) => ({
      claim_type: 'damage',
      days_to_file: 2,
      packaging: 'carrier_packed',
      full_value_coverage: false,
      weight_lb: ri(r, 3, 12) * 10,
      declared_value_usd: 0,
      damage_pct: ri(r, 20, 100),
      salvage_value_usd: 0,
    }),
    'BELOW_DEDUCTIBLE',
    'NO_NET_LOSS',
  ),
  NO_NET_LOSS: (r) => {
    const f = {
      ...baseFacts(r),
      claim_type: 'damage' as const,
      days_to_file: 2,
      packaging: 'carrier_packed' as const,
      full_value_coverage: false,
      weight_lb: ri(r, 20, 120) * 10,
      declared_value_usd: 0,
      damage_pct: ri(r, 4, 12) * 5,
    };
    const gross =
      (f.weight_lb * (f.commodity_class === 'electronics' ? 4 : f.commodity_class === 'fragile_glass' ? 1.75 : 2.5) * f.damage_pct) / 100;
    return { facts: { ...f, salvage_value_usd: Math.ceil(gross) + ri(r, 0, 60) }, codes: ['NO_NET_LOSS'] };
  },
  MANAGER: G(
    (r) => ({
      claim_type: pick(r, ['damage', 'loss'] as const),
      commodity_class: 'electronics',
      days_to_file: 2,
      packaging: 'carrier_packed',
      weight_lb: ri(r, 80, 130) * 100,
      declared_value_usd: ri(r, 300, 600) * 100,
      full_value_coverage: chance(r, 0.5),
      damage_pct: 100,
      salvage_value_usd: 0,
    }),
    'MANAGER_THRESHOLD',
  ),
  HIGH_VALUE_LATE: G(
    (r) => ({
      claim_type: 'damage',
      commodity_class: 'electronics',
      days_to_file: ri(r, 12, 25),
      pod_damage_noted: false,
      packaging: 'carrier_packed',
      weight_lb: ri(r, 80, 130) * 100,
      declared_value_usd: ri(r, 300, 600) * 100,
      damage_pct: 100,
      salvage_value_usd: 0,
    }),
    'FILING_WINDOW',
  ),
};

export const EVAL_STRATA_COUNTS: Record<string, number> = {
  HAZMAT: 3,
  FRAUD_SCREEN: 3,
  FILING_DAMAGE: 2,
  POD_EXTENDED: 3,
  FILING_OTHER: 2,
  PACKAGING: 2,
  WEATHER_DENY: 2,
  WEATHER_PAID: 2,
  MIN_DELAY: 1,
  DELAY_PAID: 3,
  TEMP_NOT_SENSITIVE: 2,
  TEMP_NO_LOG: 2,
  TEMP_TOLERANCE: 2,
  TEMP_PAID: 3,
  DAMAGE_PARTIAL: 5,
  DAMAGE_FULL: 3,
  LOSS_PAID: 3,
  BELOW_DEDUCTIBLE: 2,
  NO_NET_LOSS: 1,
  MANAGER: 3,
  HIGH_VALUE_LATE: 1,
};

function make(stratum: string, r: Rng, id: string, style: TaskStyle = 'standard'): FreightTask {
  const gen = STRATA[stratum];
  if (gen === undefined) throw new Error(`unknown stratum ${stratum}`);
  for (let attempt = 0; attempt < 500; attempt++) {
    const { facts, codes } = gen(r);
    const outcome = adjudicate(facts);
    if (!codes.includes(outcome.reason_code)) continue; // rejection sampling: the stratum label must be true
    const rendered = style === 'variant' ? renderClaimVariant(facts, r) : renderClaim(facts, r);
    return {
      id,
      stratum,
      narrative: rendered.narrative,
      statedFacts: rendered.statedFacts,
      facts,
      expected: {
        decision: outcome.decision,
        payout_usd: outcome.payout_usd,
        escalation_target: outcome.escalation_target,
        reason_code: outcome.reason_code,
      },
      factsUsed: [...new Set(outcome.factsUsed)],
    };
  }
  throw new Error(`stratum ${stratum} could not satisfy its own label in 500 attempts`);
}

/** The held-out evaluation set. Seeded, so every run (and every machine) sees the same 50 tasks. */
export function generateEvalTasks(seed = 20260101, style: TaskStyle = 'standard'): FreightTask[] {
  const r = makeRng(seed);
  const out: FreightTask[] = [];
  for (const [stratum, n] of Object.entries(EVAL_STRATA_COUNTS))
    for (let i = 0; i < n; i++) out.push(make(stratum, r, `T${String(out.length + 1).padStart(2, '0')}-${stratum}`, style));
  return out;
}

const EXEMPLAR_STRATA = [
  'HAZMAT',
  'FRAUD_SCREEN',
  'FILING_DAMAGE',
  'DAMAGE_PARTIAL',
  'DAMAGE_PARTIAL',
  'WEATHER_PAID',
  'TEMP_NO_LOG',
  'MANAGER',
  'LOSS_PAID',
  'PACKAGING',
  'MIN_DELAY',
  'TEMP_PAID',
];

/** Worked examples for the XO's reasoning_traces. A different seed and a leakage check (see tests) keep them disjoint from the eval set. */
export function generateExemplarTasks(seed = 77000777): FreightTask[] {
  const r = makeRng(seed);
  return EXEMPLAR_STRATA.map((s, i) => make(s, r, `EX${String(i + 1).padStart(2, '0')}-${s}`));
}

/** A random claim from the whole space — used for tree-vs-oracle property tests, not for evaluation. */
export function randomFacts(r: Rng): ClaimFacts {
  const t = pick(r, ['damage', 'loss', 'delay', 'temperature'] as const);
  return {
    ...baseFacts(r),
    claim_type: t,
    commodity_class: pick(r, ['general', 'electronics', 'fragile_glass', 'perishable', 'hazmat'] as const),
    claimant_claims_last_90d: ri(r, 0, 5),
    days_to_file: ri(r, 0, 70),
    packaging: pick(r, ['carrier_packed', 'shipper_adequate', 'shipper_inadequate'] as const),
    weight_lb: ri(r, 1, 2000) * 5,
    declared_value_usd: chance(r, 0.5) ? ri(r, 1, 900) * 50 : 0,
    damage_pct: ri(r, 1, 20) * 5,
    salvage_value_usd: chance(r, 0.4) ? ri(r, 1, 400) * 5 : 0,
    days_late: ri(r, 0, 10),
    weather_event: chance(r, 0.5),
    reefer_log_available: chance(r, 0.7),
    excursion_hours: ri(r, 0, 30),
  };
}
