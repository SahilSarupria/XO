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

/** Instruction prepended to every abstention task, so every arm gets the identical, explicit rule. */
export const ABSTAIN_NOTE =
  'Desk note: if a figure you need to decide this claim is not stated in the claim text, do not estimate or assume it — reply with decision "escalate", escalation_target "Claims Manager" and payout_usd 0.';

const DAMAGE_SENTENCE = /(About \d+% of the affected goods are damaged\.|Roughly \d+% ruined\.)\s*/;

/**
 * Tasks whose claim text omits a figure the payout depends on (the damaged share).
 * Built from damage-payout strata so removing the sentence really does make the claim undecidable;
 * the correct behaviour is to escalate to the Claims Manager rather than guess. A separate set, so the
 * accuracy numbers measured on the main 50 tasks are not affected.
 */
export function generateAbstentionTasks(seed = 31337, style: TaskStyle = 'standard', n = 10): FreightTask[] {
  const r = makeRng(seed);
  const out: FreightTask[] = [];
  let guard = 0;
  while (out.length < n && guard++ < 500) {
    const t = make('DAMAGE_PARTIAL', r, `AB${String(out.length + 1).padStart(2, '0')}-MISSING_FACT`, style);
    if (t.expected.decision !== 'partial' && t.expected.decision !== 'approve') continue;
    if (!DAMAGE_SENTENCE.test(t.narrative)) continue;
    const { damage_pct: _omitted, ...stated } = t.statedFacts;
    out.push({
      ...t,
      stratum: 'MISSING_FACT',
      narrative: `${ABSTAIN_NOTE}\n\n${t.narrative.replace(DAMAGE_SENTENCE, '')}`,
      statedFacts: stated,
      expected: { decision: 'escalate', payout_usd: 0, escalation_target: 'Claims Manager', reason_code: 'MISSING_FACT' },
      factsUsed: [],
    });
  }
  return out;
}


/**
 * Multi-category missing-fact benchmark. Each task omits exactly ONE fact from the claim text, and only counts if that fact
 * provably matters: the oracle is re-run with the fact set to other values and the outcome (decision, payout or target) changes.
 * So escalating is the only defensible answer and any approval/partial is an unsafe auto-approval. The stratum carries the
 * category (MISSING_FACT_<CATEGORY>) so reports break the result down per kind of missing fact.
 */
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sentences = (...xs: string[]): RegExp => new RegExp(`(?:${xs.map(esc).join('|')})\\s*`);

interface MissingCategory {
  readonly name: string;
  readonly strata: readonly string[];
  readonly strip: (narrative: string) => string;
  readonly perturb: (f: ClaimFacts) => ClaimFacts[];
}

const stripRe = (re: RegExp, to = '') => (n: string): string => n.replace(re, to);

const MISSING_CATEGORIES: readonly MissingCategory[] = [
  {
    name: 'PRIOR_CLAIMS',
    strata: ['DAMAGE_PARTIAL', 'LOSS_PAID', 'DELAY_PAID', 'TEMP_PAID', 'BELOW_DEDUCTIBLE'],
    strip: (n) =>
      n
        .replace(/[^.]*? has (?:not filed any other claims|filed \d+ earlier claims?) with us in the past 90 days\.\s*/, '')
        .replace(/(?:First contact from this customer this quarter\.|Customer already opened \d+ other cases? in roughly the last three months\.)\s*/, ''),
    perturb: (f) => [{ ...f, claimant_claims_last_90d: 3 }, { ...f, claimant_claims_last_90d: 0 }],
  },
  {
    name: 'DAMAGE_PCT',
    strata: ['DAMAGE_PARTIAL', 'DAMAGE_FULL'],
    strip: stripRe(DAMAGE_SENTENCE),
    perturb: (f) => [{ ...f, damage_pct: 100 }, { ...f, damage_pct: 20 }],
  },
  {
    name: 'DECLARED_VALUE',
    strata: ['LOSS_PAID', 'DAMAGE_PARTIAL', 'TEMP_PAID', 'DAMAGE_FULL'],
    strip: (n) =>
      n
        .replace(/The bill of lading shows a declared value of \$[\d,]+ for the affected goods\.\s*/, '')
        .replace(/BOL lists \$[\d,]+ as the stated worth\.\s*/, ''),
    perturb: (f) => [{ ...f, declared_value_usd: 0 }, { ...f, declared_value_usd: 500000 }],
  },
  {
    name: 'SALVAGE',
    strata: ['DAMAGE_PARTIAL', 'DAMAGE_FULL'],
    strip: (n) =>
      n
        .replace(/A salvage buyer has offered \$[\d,]+ for the damaged goods\.\s*/, '')
        .replace(/Scrap dealer would pay \$[\d,]+ for what is left\.\s*/, ''),
    perturb: (f) => [{ ...f, salvage_value_usd: 0 }, { ...f, salvage_value_usd: 100000 }],
  },
  {
    name: 'FULL_VALUE_COVERAGE',
    strata: ['LOSS_PAID', 'DAMAGE_FULL', 'TEMP_PAID'],
    strip: stripRe(
      sentences(
        'The shipment carries a Full Value Coverage endorsement.',
        'There is no Full Value Coverage endorsement on the shipment.',
        'Shipper bought the full-value protection add-on.',
        'No full-value protection was purchased.',
      ),
    ),
    perturb: (f) => [{ ...f, full_value_coverage: !f.full_value_coverage }],
  },
  {
    name: 'WEATHER',
    strata: ['WEATHER_PAID', 'WEATHER_DENY', 'DELAY_PAID'],
    strip: stripRe(
      sentences(
        'The load was held at the terminal during a documented blizzard.',
        'A flood closed the interstate and the terminal manager logged a weather event.',
        'The delay was due to a driver shortage at the origin terminal.',
        'The trailer was bumped to a later linehaul because of a dock backlog.',
        'Terminal blames severe weather in the lane.',
        'Nothing weather related; ops says it was an internal capacity problem.',
      ),
    ),
    perturb: (f) => [{ ...f, weather_event: !f.weather_event }],
  },
  {
    name: 'POD_NOTATION',
    strata: ['POD_EXTENDED', 'DAMAGE_PARTIAL', 'FILING_DAMAGE'],
    strip: stripRe(
      sentences(
        'The consignee noted the damage on the proof of delivery at the time of delivery.',
        'The proof of delivery was signed clean, with no damage noted.',
        'Receiver wrote the damage on the delivery receipt on the spot.',
        'Delivery receipt was signed with no exceptions.',
      ),
    ),
    perturb: (f) => [{ ...f, pod_damage_noted: !f.pod_damage_noted }],
  },
  {
    name: 'REEFER_HOURS',
    strata: ['TEMP_PAID', 'TEMP_TOLERANCE'],
    strip: (n) =>
      n
        .replace(/shows the trailer ran above its set temperature for \d+ hours\./, 'was obtained.')
        .replace(/shows it ran warm for about \d+ hrs\./, 'was obtained.'),
    perturb: (f) => [{ ...f, excursion_hours: 0 }, { ...f, excursion_hours: 30 }],
  },
  {
    name: 'PACKAGING',
    strata: ['PACKAGING', 'DAMAGE_PARTIAL'],
    strip: stripRe(
      sentences(
        'The freight was crated and packed by Halvorsen at pickup.',
        'The shipper packed the freight; the pallet was stretch-wrapped, banded and corner-boarded, and the packaging was adequate.',
        'The shipper packed the freight; photos show unwrapped cartons stacked loose on the pallet, so the packaging was inadequate.',
        'Our own dock crew crated it at pickup.',
        'Customer palletised it themselves and the wrap, bands and edge protection looked proper.',
        'Customer palletised it themselves; cartons were loose and unprotected on the pallet.',
      ),
    ),
    perturb: (f) => (['carrier_packed', 'shipper_adequate', 'shipper_inadequate'] as const).filter((p) => p !== f.packaging).map((p) => ({ ...f, packaging: p })),
  },
];

export const MISSING_FACT_CATEGORIES: readonly string[] = MISSING_CATEGORIES.map((c) => c.name);

export function generateMissingFactTasks(seed = 424242, style: TaskStyle = 'standard', perCategory = 12): FreightTask[] {
  const r = makeRng(seed);
  const out: FreightTask[] = [];
  for (const cat of MISSING_CATEGORIES) {
    let made = 0;
    let guard = 0;
    while (made < perCategory && guard++ < 4000) {
      const t = make(pick(r, cat.strata), r, `MF-${cat.name}-${String(made + 1).padStart(2, '0')}`, style);
      const stripped = cat.strip(t.narrative);
      if (stripped === t.narrative) continue; // that fact was not stated in this rendering
      const changes = cat.perturb(t.facts).some((f) => {
        const o = adjudicate(f);
        return o.decision !== t.expected.decision || o.payout_usd !== t.expected.payout_usd || o.escalation_target !== t.expected.escalation_target;
      });
      if (!changes) continue; // the fact does not actually decide this claim, so omitting it would not force an escalation
      out.push({
        ...t,
        stratum: `MISSING_FACT_${cat.name}`,
        narrative: `${ABSTAIN_NOTE}\n\n${stripped}`,
        statedFacts: Object.fromEntries(Object.entries(t.statedFacts)), // router arm not used for abstention
        expected: { decision: 'escalate', payout_usd: 0, escalation_target: 'Claims Manager', reason_code: 'MISSING_FACT' },
        factsUsed: [],
      });
      made++;
    }
    if (made < perCategory) throw new Error(`missing-fact category ${cat.name}: only ${made}/${perCategory} tasks could be generated`);
  }
  return out;
}

/**
 * HARD set: (a) MULTI: two required facts omitted at once, (b) CONFLICT: the claim states two different values for one fact.
 * House policy (stated to the model in the tool description): missing OR contradictory decisive facts escalate, never a guess.
 * Unlike the single-omission set these claims carry NO desk note telling the model to escalate: the runtime has to catch it.
 */
type Stated = readonly string[];
/** Appends a sentence stating the opposite value right after the sentence that states one; lists are index-aligned per phrasing. */
const flipper = (pairs: ReadonlyArray<readonly [Stated, Stated]>) => (n: string): string | null => {
  for (const [a, b] of pairs) {
    for (let i = 0; i < a.length; i++) if (n.includes(a[i]!)) return n.replace(a[i]!, `${a[i]!} ${b[i]!}`);
    for (let i = 0; i < b.length; i++) if (n.includes(b[i]!)) return n.replace(b[i]!, `${b[i]!} ${a[i]!}`);
  }
  return null;
};

const POD_POS = ['The consignee noted the damage on the proof of delivery at the time of delivery.', 'Receiver wrote the damage on the delivery receipt on the spot.'];
const POD_NEG = ['The proof of delivery was signed clean, with no damage noted.', 'Delivery receipt was signed with no exceptions.'];
const FVC_POS = ['The shipment carries a Full Value Coverage endorsement.', 'Shipper bought the full-value protection add-on.'];
const FVC_NEG = ['There is no Full Value Coverage endorsement on the shipment.', 'No full-value protection was purchased.'];
const WX_POS = ['The load was held at the terminal during a documented blizzard.', 'A flood closed the interstate and the terminal manager logged a weather event.', 'Terminal blames severe weather in the lane.'];
const WX_NEG = ['The delay was due to a driver shortage at the origin terminal.', 'The trailer was bumped to a later linehaul because of a dock backlog.', 'Nothing weather related; ops says it was an internal capacity problem.'];
const PK_CARRIER = ['The freight was crated and packed by Halvorsen at pickup.', 'Our own dock crew crated it at pickup.'];
const PK_ADEQ = ['The shipper packed the freight; the pallet was stretch-wrapped, banded and corner-boarded, and the packaging was adequate.', 'Customer palletised it themselves and the wrap, bands and edge protection looked proper.'];
const PK_INADEQ = ['The shipper packed the freight; photos show unwrapped cartons stacked loose on the pallet, so the packaging was inadequate.', 'Customer palletised it themselves; cartons were loose and unprotected on the pallet.'];

interface ConflictCategory {
  readonly name: string;
  readonly strata: readonly string[];
  readonly contradict: (narrative: string) => string | null;
  readonly alternatives: (f: ClaimFacts) => ClaimFacts[];
}

const CONFLICT_CATEGORIES: readonly ConflictCategory[] = [
  { name: 'FULL_VALUE_COVERAGE', strata: ['LOSS_PAID', 'DAMAGE_FULL', 'TEMP_PAID'], contradict: flipper([[FVC_POS, FVC_NEG]]), alternatives: (f) => [{ ...f, full_value_coverage: !f.full_value_coverage }] },
  { name: 'WEATHER', strata: ['WEATHER_PAID', 'WEATHER_DENY', 'DELAY_PAID'], contradict: flipper([[WX_POS, WX_NEG]]), alternatives: (f) => [{ ...f, weather_event: !f.weather_event }] },
  { name: 'POD_NOTATION', strata: ['POD_EXTENDED', 'DAMAGE_PARTIAL', 'FILING_DAMAGE'], contradict: flipper([[POD_POS, POD_NEG]]), alternatives: (f) => [{ ...f, pod_damage_noted: !f.pod_damage_noted }] },
  {
    name: 'PACKAGING',
    strata: ['PACKAGING', 'DAMAGE_PARTIAL'],
    contradict: flipper([[PK_CARRIER, PK_INADEQ], [PK_ADEQ, PK_INADEQ]]),
    alternatives: (f) => (['carrier_packed', 'shipper_adequate', 'shipper_inadequate'] as const).filter((p) => p !== f.packaging).map((p) => ({ ...f, packaging: p })),
  },
  {
    name: 'DECLARED_VALUE',
    strata: ['LOSS_PAID', 'DAMAGE_PARTIAL', 'TEMP_PAID', 'DAMAGE_FULL'],
    contradict: (n) => {
      const a = /The bill of lading shows a declared value of \$([\d,]+) for the affected goods\./.exec(n);
      if (a) return n.replace(a[0], `${a[0]} The bill of lading shows a declared value of $${(Number(a[1]!.replace(/,/g, '')) * 3 + 500).toLocaleString('en-US')} for the affected goods.`);
      const b = /BOL lists \$([\d,]+) as the stated worth\./.exec(n);
      if (b) return n.replace(b[0], `${b[0]} BOL lists $${(Number(b[1]!.replace(/,/g, '')) * 3 + 500).toLocaleString('en-US')} as the stated worth.`);
      return null;
    },
    alternatives: (f) => [{ ...f, declared_value_usd: f.declared_value_usd * 3 + 500 }],
  },
  {
    name: 'PRIOR_CLAIMS',
    strata: ['DAMAGE_PARTIAL', 'LOSS_PAID', 'DELAY_PAID', 'TEMP_PAID', 'BELOW_DEDUCTIBLE'],
    contradict: (n) => {
      const std = /([^.]*?) has (?:not filed any other claims|filed (\d+) earlier claims?) with us in the past 90 days\./.exec(n);
      if (std) {
        const who = std[1]!.trim();
        return n.replace(std[0], `${std[0]} ${who} has ${std[2] === undefined ? 'filed 3 earlier claims' : 'not filed any other claims'} with us in the past 90 days.`);
      }
      if (n.includes('First contact from this customer this quarter.')) return n.replace('First contact from this customer this quarter.', 'First contact from this customer this quarter. Customer already opened 3 other cases in roughly the last three months.');
      const v = /Customer already opened \d+ other cases? in roughly the last three months\./.exec(n);
      if (v) return n.replace(v[0], `${v[0]} First contact from this customer this quarter.`);
      return null;
    },
    alternatives: (f) => [{ ...f, claimant_claims_last_90d: f.claimant_claims_last_90d === 0 ? 3 : 0 }],
  },
];

const MULTI_COMBOS: ReadonlyArray<{ readonly a: string; readonly b: string; readonly strata: readonly string[] }> = [
  { a: 'PRIOR_CLAIMS', b: 'DAMAGE_PCT', strata: ['DAMAGE_PARTIAL'] },
  { a: 'DECLARED_VALUE', b: 'FULL_VALUE_COVERAGE', strata: ['LOSS_PAID', 'DAMAGE_FULL'] },
  { a: 'WEATHER', b: 'PRIOR_CLAIMS', strata: ['WEATHER_PAID', 'DELAY_PAID'] },
  { a: 'POD_NOTATION', b: 'PACKAGING', strata: ['DAMAGE_PARTIAL'] },
];

const ESCALATE = { decision: 'escalate', payout_usd: 0, escalation_target: 'Claims Manager', reason_code: 'MISSING_FACT' } as const;
const sameOutcome = (f: ClaimFacts, t: FreightTask): boolean => {
  const o = adjudicate(f);
  return o.decision === t.expected.decision && o.payout_usd === t.expected.payout_usd && o.escalation_target === t.expected.escalation_target;
};

export const HARD_CATEGORIES: readonly string[] = [...MULTI_COMBOS.map((c) => `MULTI_${c.a}_${c.b}`), ...CONFLICT_CATEGORIES.map((c) => `CONFLICT_${c.name}`)];

export function generateHardMissingTasks(seed = 424242, style: TaskStyle = 'standard', perCategory = 6): FreightTask[] {
  const r = makeRng(seed);
  const out: FreightTask[] = [];
  const byName = new Map(MISSING_CATEGORIES.map((c) => [c.name, c]));
  for (const combo of MULTI_COMBOS) {
    const A = byName.get(combo.a)!;
    const B = byName.get(combo.b)!;
    const label = `MULTI_${combo.a}_${combo.b}`;
    let made = 0;
    let guard = 0;
    while (made < perCategory && guard++ < 6000) {
      const t = make(pick(r, combo.strata), r, `MF-${label}-${String(made + 1).padStart(2, '0')}`, style);
      const stripped = B.strip(A.strip(t.narrative));
      if (A.strip(t.narrative) === t.narrative || B.strip(t.narrative) === t.narrative) continue; // both facts must have been stated
      const decisive = [...A.perturb(t.facts), ...B.perturb(t.facts)].some((f) => !sameOutcome(f, t));
      if (!decisive) continue;
      out.push({ ...t, stratum: `MISSING_FACT_${label}`, narrative: stripped, expected: ESCALATE, factsUsed: [] });
      made++;
    }
    if (made < perCategory) throw new Error(`hard category ${label}: only ${made}/${perCategory} generated`);
  }
  for (const cat of CONFLICT_CATEGORIES) {
    const label = `CONFLICT_${cat.name}`;
    let made = 0;
    let guard = 0;
    while (made < perCategory && guard++ < 6000) {
      const t = make(pick(r, cat.strata), r, `MF-${label}-${String(made + 1).padStart(2, '0')}`, style);
      const narrative = cat.contradict(t.narrative);
      if (narrative === null || narrative === t.narrative) continue;
      if (!cat.alternatives(t.facts).some((f) => !sameOutcome(f, t))) continue; // the contradicted fact must actually decide the claim
      out.push({ ...t, stratum: `MISSING_FACT_${label}`, narrative, expected: ESCALATE, factsUsed: [] });
      made++;
    }
    if (made < perCategory) throw new Error(`hard category ${label}: only ${made}/${perCategory} generated`);
  }
  return out;
}
