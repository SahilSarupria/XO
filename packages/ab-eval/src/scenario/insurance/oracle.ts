import { makeRng, type Rng } from '../freight/render.js';

/** Independent ground truth for the Meridian manual: a plain imperative reading, written without looking at compiler output. */
export type InsuranceClaimType = 'collision' | 'glass' | 'theft';
export interface InsuranceFacts {
  claim_type: InsuranceClaimType;
  injury_involved: boolean;
  policy_in_force: boolean;
  claims_last_12m: number;
  days_to_report: number;
  police_report_filed: boolean;
  repair_estimate_usd: number;
  vehicle_value_usd: number;
  rental_coverage: boolean;
  rental_days: number;
}
export interface InsuranceOutcome {
  decision: 'approve' | 'deny' | 'escalate';
  payout_usd: number;
  escalation_target: string | null;
}

export const INSURANCE_DEDUCTIBLE: Record<InsuranceClaimType, number> = { collision: 500, glass: 250, theft: 1000 };
export const INSURANCE_WINDOW_DAYS: Record<InsuranceClaimType, number> = { collision: 30, glass: 90, theft: 30 };

export function adjudicateInsurance(f: InsuranceFacts): InsuranceOutcome {
  const out = (decision: InsuranceOutcome['decision'], payout: number, target: string | null): InsuranceOutcome => ({
    decision,
    payout_usd: payout,
    escalation_target: target,
  });
  if (f.injury_involved) return out('escalate', 0, 'Casualty Unit');
  if (!f.policy_in_force) return out('deny', 0, null);
  if (f.claims_last_12m >= 2) return out('escalate', 0, 'SIU');
  if (f.days_to_report > INSURANCE_WINDOW_DAYS[f.claim_type]) return out('deny', 0, null);
  if (f.claim_type === 'theft' && !f.police_report_filed) return out('deny', 0, null);
  const deductible = INSURANCE_DEDUCTIBLE[f.claim_type];
  if (f.repair_estimate_usd <= deductible) return out('deny', 0, null);
  const totalLoss = f.repair_estimate_usd > 0.75 * f.vehicle_value_usd;
  let pay = (totalLoss ? f.vehicle_value_usd : f.repair_estimate_usd) - deductible;
  if (f.rental_coverage) pay += 40 * Math.min(f.rental_days, 14);
  if (pay > 15000) return out('escalate', 0, 'Senior Adjuster');
  return out('approve', Math.round(pay * 100) / 100, null);
}

export interface InsuranceTask {
  readonly id: string;
  readonly stratum: string;
  readonly facts: InsuranceFacts;
  readonly expected: InsuranceOutcome;
}

const ri = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pickOf = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;

function base(r: Rng): InsuranceFacts {
  const value = ri(r, 4, 40) * 1000;
  return {
    claim_type: pickOf(r, ['collision', 'glass', 'theft'] as const),
    injury_involved: false,
    policy_in_force: true,
    claims_last_12m: ri(r, 0, 1),
    days_to_report: ri(r, 1, 25),
    police_report_filed: true,
    repair_estimate_usd: ri(r, 6, 60) * 100,
    vehicle_value_usd: value,
    rental_coverage: r() < 0.5,
    rental_days: ri(r, 0, 20),
  };
}

const STRATA: readonly { name: string; n: number; make: (f: InsuranceFacts, r: Rng) => InsuranceFacts }[] = [
  { name: 'plain', n: 8, make: (f) => f },
  { name: 'injury', n: 4, make: (f) => ({ ...f, injury_involved: true }) },
  { name: 'lapsed', n: 4, make: (f) => ({ ...f, policy_in_force: false }) },
  { name: 'repeat', n: 5, make: (f, r) => ({ ...f, claims_last_12m: ri(r, 2, 5), days_to_report: ri(r, 20, 60) }) },
  { name: 'late', n: 6, make: (f, r) => ({ ...f, days_to_report: INSURANCE_WINDOW_DAYS[f.claim_type] + ri(r, 1, 30) }) },
  { name: 'boundary-window', n: 4, make: (f) => ({ ...f, days_to_report: INSURANCE_WINDOW_DAYS[f.claim_type] }) },
  { name: 'theft-no-report', n: 4, make: (f) => ({ ...f, claim_type: 'theft', police_report_filed: false }) },
  {
    name: 'below-deductible',
    n: 4,
    make: (f) => ({ ...f, repair_estimate_usd: INSURANCE_DEDUCTIBLE[f.claim_type] - ri(makeRng(f.vehicle_value_usd), 0, 100) }),
  },
  { name: 'total-loss', n: 6, make: (f, r) => ({ ...f, repair_estimate_usd: Math.round(f.vehicle_value_usd * (0.76 + r() * 0.2)) }) },
  { name: 'boundary-75pct', n: 3, make: (f) => ({ ...f, repair_estimate_usd: Math.round(f.vehicle_value_usd * 0.75) }) },
  {
    name: 'big-payment',
    n: 4,
    make: (f) => ({
      ...f,
      vehicle_value_usd: 30000 + ri(makeRng(f.repair_estimate_usd), 0, 20000),
      repair_estimate_usd: 20000 + ri(makeRng(f.repair_estimate_usd + 1), 0, 20000),
    }),
  },
  { name: 'rental-cap', n: 4, make: (f) => ({ ...f, rental_coverage: true, rental_days: 14 + ri(makeRng(f.repair_estimate_usd), 1, 10) }) },
];

export function generateInsuranceTasks(seed = 424242): InsuranceTask[] {
  const r = makeRng(seed);
  const out: InsuranceTask[] = [];
  for (const s of STRATA)
    for (let i = 0; i < s.n; i++) {
      const facts = s.make(base(r), r);
      out.push({ id: `${s.name}-${i + 1}`, stratum: s.name, facts, expected: adjudicateInsurance(facts) });
    }
  return out;
}
