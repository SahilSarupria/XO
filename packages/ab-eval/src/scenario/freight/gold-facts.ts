/**
 * Atomic facts a package must "know" to adjudicate Halvorsen claims. A fact is
 * *present* in a package when a single knowledge node's text matches every
 * pattern — i.e. the pieces needed to apply it sit together, which is what a
 * retriever can actually hand to a model. Used to score any XO (gold or
 * compiled) without calling an LLM.
 */
export interface GoldFact {
  readonly id: string;
  readonly description: string;
  readonly patterns: readonly RegExp[];
}

export const GOLD_FACTS: readonly GoldFact[] = [
  {
    id: 'F_ORDER',
    description: 'order of review: hazmat, fraud, window, exclusions, payout, manager',
    patterns: [/hazmat/i, /fraud/i, /window/i, /manager/i],
  },
  { id: 'F_HAZMAT', description: 'hazmat → Hazmat Compliance', patterns: [/hazmat/i, /Hazmat Compliance/] },
  { id: 'F_FRAUD', description: '3+ claims in 90 days → SIU', patterns: [/\b3 or more\b/i, /\b90 days\b/, /SIU/] },
  { id: 'F_WINDOW_DAMAGE', description: 'damage window 9 days', patterns: [/damage/i, /\b9 days\b/] },
  { id: 'F_WINDOW_DAMAGE_POD', description: 'damage noted on POD → 30 days', patterns: [/proof of delivery|POD/i, /\b30 days\b/] },
  { id: 'F_WINDOW_LOSS', description: 'loss window 60 days', patterns: [/\bloss\b/i, /\b60 days\b/] },
  { id: 'F_WINDOW_DELAY', description: 'delay window 5 days', patterns: [/delay/i, /\b5 days\b/] },
  { id: 'F_WINDOW_TEMP', description: 'temperature window 4 days', patterns: [/temperature/i, /\b4 days\b/] },
  { id: 'F_PACKAGING', description: 'inadequate shipper packaging excluded', patterns: [/packag/i, /inadequate/i] },
  { id: 'F_DELAY_MIN', description: 'delay needs 2+ days', patterns: [/\b2 days\b/i, /delay/i] },
  { id: 'F_DELAY_WEATHER', description: 'weather: first 3 days not compensable', patterns: [/weather/i, /\b3 days\b/] },
  { id: 'F_DELAY_PAY', description: '$85/day up to 5 days', patterns: [/\$85/, /\b5 days\b/] },
  {
    id: 'F_TEMP_RULES',
    description: 'perishable only; log needed else Cold Chain Desk; 6h tolerance',
    patterns: [/\b6 hours\b/, /Cold Chain Desk/],
  },
  { id: 'F_RATES', description: 'per-lb rates 2.50/4.00/1.75', patterns: [/2\.50/, /4\.00/, /1\.75/] },
  {
    id: 'F_BASE',
    description: 'base value with/without Full Value Coverage',
    patterns: [/Full Value Coverage/i, /declared value/i, /liability cap/i],
  },
  { id: 'F_DEDUCTIBLE', description: '$150 deductible unless FVC', patterns: [/\$150/, /deductible/i] },
  { id: 'F_MANAGER', description: '> $25,000 → Claims Manager', patterns: [/25,000/, /Claims Manager/] },
];
