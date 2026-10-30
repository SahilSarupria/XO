import type { ClaimFacts, Outcome } from './facts.js';

/**
 * The ground truth for the Halvorsen scenario: a plain imperative
 * implementation of the claims-desk manual. It is deliberately written
 * independently of the decision-tree JSON in gold-xo.ts — a test cross-checks
 * the two on thousands of random claims, so a transcription error in either
 * shows up as a disagreement rather than a silently wrong "gold" XO.
 */

const r2 = (x: number): number => Math.round((x + Number.EPSILON) * 100) / 100;
const money = (x: number): string => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const RATE_PER_LB: Record<string, number> = { general: 2.5, electronics: 4.0, fragile_glass: 1.75, perishable: 2.5 };
export const DEDUCTIBLE = 150;
export const MANAGER_THRESHOLD = 25000;
export const DELAY_PER_DAY = 85;

export function adjudicate(f: ClaimFacts): Outcome {
  const steps: string[] = [];
  const rules: string[] = [];
  const used: string[] = ['F_ORDER'];
  const done = (decision: Outcome['decision'], payout: number, target: string | null, code: string, why: string): Outcome => {
    steps.push(why);
    return { decision, payout_usd: payout, escalation_target: target, reason_code: code, rules, factsUsed: used, steps };
  };

  rules.push('R1');
  used.push('F_HAZMAT');
  if (f.commodity_class === 'hazmat')
    return done(
      'escalate',
      0,
      'Hazmat Compliance',
      'HAZMAT',
      'Commodity is hazmat → escalate to Hazmat Compliance; the desk never pays or denies hazmat claims, whatever the amount or filing date.',
    );
  steps.push('Not hazmat, so continue.');

  rules.push('R2');
  used.push('F_FRAUD');
  if (f.claimant_claims_last_90d >= 3)
    return done(
      'escalate',
      0,
      'SIU',
      'FRAUD_SCREEN',
      `Claimant has ${f.claimant_claims_last_90d} earlier claims in 90 days (3 or more) → escalate to SIU before looking at anything else, even if the claim is late.`,
    );
  steps.push(`Claimant has ${f.claimant_claims_last_90d} earlier claim(s) in 90 days (under 3), so no fraud screen.`);

  rules.push('R3');
  let window: number;
  if (f.claim_type === 'damage') {
    window = f.pod_damage_noted ? 30 : 9;
    used.push(f.pod_damage_noted ? 'F_WINDOW_DAMAGE_POD' : 'F_WINDOW_DAMAGE');
    used.push('F_WINDOW_DAMAGE');
  } else if (f.claim_type === 'loss') {
    window = 60;
    used.push('F_WINDOW_LOSS');
  } else if (f.claim_type === 'delay') {
    window = 5;
    used.push('F_WINDOW_DELAY');
  } else {
    window = 4;
    used.push('F_WINDOW_TEMP');
  }
  if (f.days_to_file > window)
    return done(
      'deny',
      0,
      null,
      'FILING_WINDOW',
      `Filed ${f.days_to_file} days after the event; the ${f.claim_type} window is ${window} days → deny as late.`,
    );
  steps.push(`Filed ${f.days_to_file} days after the event, inside the ${window}-day ${f.claim_type} window.`);

  rules.push('R4');
  let pct = 100;
  let salvage = 0;

  if (f.claim_type === 'delay') {
    let compensable: number;
    if (f.weather_event) {
      used.push('F_DELAY_WEATHER');
      if (f.days_late <= 3)
        return done(
          'deny',
          0,
          null,
          'WEATHER',
          `Delay was caused by a weather event and lasted ${f.days_late} days; the first 3 days are not compensable → deny.`,
        );
      compensable = f.days_late - 3;
      steps.push(`Weather delay of ${f.days_late} days: first 3 days excluded, ${compensable} compensable.`);
    } else {
      used.push('F_DELAY_MIN');
      if (f.days_late < 2)
        return done('deny', 0, null, 'MIN_DELAY', `Only ${f.days_late} day(s) late; delay claims need at least 2 days → deny.`);
      compensable = f.days_late;
      steps.push(`${f.days_late} days late, no weather event: ${compensable} compensable.`);
    }
    used.push('F_DELAY_PAY');
    const days = Math.min(compensable, 5);
    const pay = r2(DELAY_PER_DAY * days);
    steps.push(
      `Pay ${money(DELAY_PER_DAY)} per day, capped at 5 days: ${days} × ${money(DELAY_PER_DAY)} = ${money(pay)}. No deductible on delay claims.`,
    );
    return done('approve', pay, null, 'DELAY_PAID', 'Delay claim is payable.');
  }

  if (f.claim_type === 'temperature') {
    used.push('F_TEMP_RULES');
    if (f.commodity_class !== 'perishable')
      return done('deny', 0, null, 'NOT_TEMP_SENSITIVE', 'Temperature claims are only payable for perishable freight → deny.');
    if (!f.reefer_log_available)
      return done(
        'escalate',
        0,
        'Cold Chain Desk',
        'NO_REEFER_LOG',
        'No reefer temperature log is available, so the excursion cannot be verified → escalate to the Cold Chain Desk.',
      );
    if (f.excursion_hours <= 6)
      return done('deny', 0, null, 'WITHIN_TOLERANCE', `Excursion of ${f.excursion_hours} hours is within the 6-hour tolerance → deny.`);
    steps.push(`Excursion of ${f.excursion_hours} hours exceeds the 6-hour tolerance; payable as a total loss.`);
  } else if (f.claim_type === 'damage') {
    used.push('F_PACKAGING');
    if (f.packaging === 'shipper_inadequate')
      return done('deny', 0, null, 'PACKAGING', 'Shipper packed the freight and the packaging was inadequate → deny.');
    pct = f.damage_pct;
    salvage = f.salvage_value_usd;
    steps.push(
      `Packaging is ${f.packaging === 'carrier_packed' ? 'carrier-packed' : 'adequate'}; damage is ${pct}% with ${money(salvage)} salvage.`,
    );
  } else {
    steps.push('Loss claim: treated as 100% damage with no salvage.');
  }

  rules.push('R5');
  used.push('F_RATES', 'F_BASE', 'F_DEDUCTIBLE');
  const rate = RATE_PER_LB[f.commodity_class] ?? 2.5;
  const cap = f.weight_lb * rate;
  const base = f.full_value_coverage ? f.declared_value_usd : f.declared_value_usd > 0 ? Math.min(f.declared_value_usd, cap) : cap;
  steps.push(
    `Liability cap = ${f.weight_lb} lb × ${money(rate)}/lb = ${money(cap)}. ` +
      (f.full_value_coverage
        ? `Full Value Coverage applies, so the base is the declared value ${money(f.declared_value_usd)}.`
        : f.declared_value_usd > 0
          ? `No full value coverage: base = lesser of declared value ${money(f.declared_value_usd)} and the cap = ${money(base)}.`
          : `No value declared: base = the cap = ${money(base)}.`),
  );
  const gross = (base * pct) / 100;
  const net = gross - salvage;
  if (net <= 0)
    return done(
      'deny',
      0,
      null,
      'NO_NET_LOSS',
      `After ${pct}% damage (${money(gross)}) and ${money(salvage)} salvage there is no net loss → deny.`,
    );
  const deductible = f.full_value_coverage ? 0 : DEDUCTIBLE;
  const payout = net - deductible;
  steps.push(`Loss ${money(gross)} − salvage ${money(salvage)} = ${money(net)}; deductible ${money(deductible)} → ${money(payout)}.`);
  if (payout <= 0) return done('deny', 0, null, 'BELOW_DEDUCTIBLE', 'Net loss does not exceed the deductible → deny.');

  rules.push('R6');
  used.push('F_MANAGER');
  if (payout > MANAGER_THRESHOLD)
    return done(
      'escalate',
      0,
      'Claims Manager',
      'MANAGER_THRESHOLD',
      `Computed payout ${money(r2(payout))} exceeds $25,000 → escalate to the Claims Manager; the desk never approves above $25,000.`,
    );
  const final = r2(payout);
  const decision = f.claim_type === 'damage' && pct < 100 ? 'partial' : 'approve';
  return done(
    decision,
    final,
    null,
    decision === 'partial' ? 'DAMAGE_PARTIAL' : 'PAID',
    `Payout ${money(final)} is within authority → ${decision}.`,
  );
}
