import type { ClaimFacts, CommodityClass } from './facts.js';

export type Rng = () => number;

/** mulberry32 — tiny, seedable, good enough for reproducible task sets. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const ri = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
export const chance = (r: Rng, p: number): boolean => r() < p;

const GOODS: Record<CommodityClass, readonly string[]> = {
  general: ['steel fittings', 'auto accessories', 'bagged dry goods', 'machine parts', 'garden tools'],
  electronics: ['server chassis', 'LED display panels', 'laptops', 'network switches'],
  fragile_glass: ['glass tabletops', 'laboratory glassware', 'framed mirrors', 'window units'],
  perishable: ['frozen seafood', 'dairy products', 'fresh produce', 'chilled pharmaceuticals'],
  hazmat: ['pool chemicals', 'lithium battery packs', 'paint thinner drums', 'aerosol cases'],
};
const CLAIMANTS = [
  'Brightwater Supply',
  'Okafor & Daughters',
  'Lindqvist Outfitters',
  'Pacific Rim Traders',
  'Marlow Hardware',
  'Tanaka Imports',
  'Delacroix Foods',
  'Ridgeline Tech',
  'Corvus Labs',
  'Hollis Distribution',
];
const DRIVERS = ['M. Alvarez', 'T. Brandt', 'S. Nwosu', 'P. Kowalski', 'D. Haynes'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function addDays(base: Date, n: number): Date {
  return new Date(base.getTime() + n * 86_400_000);
}
export function fmtDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
const usd = (n: number): string => `$${n.toLocaleString('en-US')}`;

export interface RenderedClaim {
  narrative: string;
  /** The facts a structured intake form for this claim would carry (what the narrative actually states, with day counts already derived). */
  statedFacts: Partial<ClaimFacts>;
}

export function renderClaim(f: ClaimFacts, rng: Rng): RenderedClaim {
  const goods = pick(rng, GOODS[f.commodity_class]);
  const claimant = pick(rng, CLAIMANTS);
  const driver = pick(rng, DRIVERS);
  const base = new Date(Date.UTC(2026, ri(rng, 0, 7), ri(rng, 2, 24)));
  const claimNo = `HF-CL-${ri(rng, 10000, 99999)}`;
  const pro = `PRO ${ri(rng, 400000, 999999)}`;
  const askedFor = usd(ri(rng, 4, 90) * 100 + ri(rng, 0, 9) * 10);
  const priors =
    f.claimant_claims_last_90d === 0
      ? `${claimant} has not filed any other claims with us in the past 90 days.`
      : `${claimant} has filed ${f.claimant_claims_last_90d} earlier claim${f.claimant_claims_last_90d === 1 ? '' : 's'} with us in the past 90 days.`;
  const value =
    f.declared_value_usd > 0
      ? `The bill of lading shows a declared value of ${usd(f.declared_value_usd)} for the affected goods.`
      : 'No value was declared on the bill of lading.';
  const fvc = f.full_value_coverage
    ? 'The shipment carries a Full Value Coverage endorsement.'
    : 'There is no Full Value Coverage endorsement on the shipment.';
  const stated: Partial<ClaimFacts> = {
    claim_type: f.claim_type,
    commodity_class: f.commodity_class,
    claimant_claims_last_90d: f.claimant_claims_last_90d,
    days_to_file: f.days_to_file,
  };
  const head = `Claim ${claimNo} (${pro}), driver ${driver}. TMS commodity class: ${f.commodity_class.replace('_', ' ')}.`;
  let body: string;

  if (f.claim_type === 'loss') {
    const filed = addDays(base, f.days_to_file);
    body = `${claimant} reports that a shipment of ${goods} (${f.weight_lb} lb) scheduled for delivery on ${fmtDate(base)} never arrived. The claim was filed on ${fmtDate(filed)}. ${value} ${fvc} ${priors} They are asking for ${askedFor}.`;
    Object.assign(stated, { weight_lb: f.weight_lb, declared_value_usd: f.declared_value_usd, full_value_coverage: f.full_value_coverage });
  } else if (f.claim_type === 'delay') {
    const actual = addDays(base, f.days_late);
    const filed = addDays(actual, f.days_to_file);
    const cause = f.weather_event
      ? pick(rng, [
          'The load was held at the terminal during a documented blizzard.',
          'A flood closed the interstate and the terminal manager logged a weather event.',
        ])
      : pick(rng, [
          'The delay was due to a driver shortage at the origin terminal.',
          'The trailer was bumped to a later linehaul because of a dock backlog.',
        ]);
    body = `${claimant} says a shipment of ${goods} was scheduled for delivery on ${fmtDate(base)} but was actually delivered on ${fmtDate(actual)}. ${cause} The delay claim was filed on ${fmtDate(filed)}. ${priors} They are asking for ${askedFor}.`;
    Object.assign(stated, { days_late: f.days_late, weather_event: f.weather_event });
  } else if (f.claim_type === 'temperature') {
    const delivered = base;
    const filed = addDays(delivered, f.days_to_file);
    const log = f.reefer_log_available
      ? `The reefer log was downloaded and shows the trailer ran above its set temperature for ${f.excursion_hours} hours.`
      : pick(rng, [
          'The reefer unit’s temperature log could not be downloaded, so there is no log for this trip.',
          'The terminal reports that no reefer log is available for this load.',
        ]);
    body = `${claimant} claims temperature damage to ${f.weight_lb} lb of ${goods}, delivered on ${fmtDate(delivered)}; the claim was filed on ${fmtDate(filed)}. ${log} ${value} ${fvc} ${priors} They are asking for ${askedFor}.`;
    Object.assign(stated, {
      weight_lb: f.weight_lb,
      declared_value_usd: f.declared_value_usd,
      full_value_coverage: f.full_value_coverage,
      reefer_log_available: f.reefer_log_available,
      ...(f.reefer_log_available ? { excursion_hours: f.excursion_hours } : {}),
    });
  } else {
    const filed = addDays(base, f.days_to_file);
    const pack =
      f.packaging === 'carrier_packed'
        ? 'The freight was crated and packed by Halvorsen at pickup.'
        : f.packaging === 'shipper_adequate'
          ? 'The shipper packed the freight; the pallet was stretch-wrapped, banded and corner-boarded, and the packaging was adequate.'
          : 'The shipper packed the freight; photos show unwrapped cartons stacked loose on the pallet, so the packaging was inadequate.';
    const pod = f.pod_damage_noted
      ? 'The consignee noted the damage on the proof of delivery at the time of delivery.'
      : 'The proof of delivery was signed clean, with no damage noted.';
    const salvage =
      f.salvage_value_usd > 0
        ? `A salvage buyer has offered ${usd(f.salvage_value_usd)} for the damaged goods.`
        : 'The damaged goods have no salvage value.';
    body = `${claimant} reports damage to ${f.weight_lb} lb of ${goods}, delivered on ${fmtDate(base)}; the claim was filed on ${fmtDate(filed)}. About ${f.damage_pct}% of the affected goods are damaged. ${pack} ${pod} ${value} ${fvc} ${salvage} ${priors} They are asking for ${askedFor}.`;
    Object.assign(stated, {
      weight_lb: f.weight_lb,
      declared_value_usd: f.declared_value_usd,
      full_value_coverage: f.full_value_coverage,
      damage_pct: f.damage_pct,
      salvage_value_usd: f.salvage_value_usd,
      packaging: f.packaging,
      pod_damage_noted: f.pod_damage_noted,
    });
  }
  return { narrative: `${head} ${body}`, statedFacts: stated };
}
