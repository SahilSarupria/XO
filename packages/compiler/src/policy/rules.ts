import type { PolicyEntry } from './segment.js';

/**
 * Rule extraction: reads decision-relevant clauses out of policy prose with a small library of clause patterns and
 * returns the parameters (numbers, targets, tables) it found PLUS an honest review report of every normative sentence
 * it did not understand.
 *
 * Scope, stated plainly: this is pattern-based, not understanding. It recognizes the clause shapes below; a policy
 * written in other shapes yields fewer recognized clauses, a smaller tree, and a longer `unrecognized` list. It never
 * guesses: parameters come only from numbers and names present in the text.
 */

export interface GateClause {
  readonly rule: string;
  readonly variable: string;
  readonly op: '==' | '>=';
  readonly value: string | number;
  readonly target: string;
  readonly sentence: string;
}

export interface WindowClause {
  readonly selector: string; // e.g. claim_type
  readonly kind: string; // e.g. damage
  readonly days: number;
  readonly event: string;
}

export interface RecognizedClause {
  readonly kind: string;
  readonly rule: string;
  readonly sentence: string;
}

export interface UnrecognizedClause {
  readonly rule: string;
  readonly section: string;
  readonly sentence: string;
}

export interface RuleSet {
  readonly gates: readonly GateClause[];
  readonly windows: readonly WindowClause[];
  readonly extension?: { readonly days: number; readonly variable: string; readonly appliesTo: string };
  readonly packagingExclusion: boolean;
  readonly minDelayDays?: number;
  readonly weatherExcludedDays?: number;
  readonly delay?: { readonly perDay: number; readonly maxDays: number };
  readonly temperature: {
    readonly perishableOnly: boolean;
    readonly noLogTarget?: string;
    readonly toleranceHours?: number;
  };
  readonly rates: readonly { readonly cls: string; readonly perLb: number }[];
  readonly baseValueRule: boolean;
  readonly deductible?: number;
  readonly fullCoverageWaivesDeductible: boolean;
  readonly lossIsTotal: boolean;
  readonly threshold?: { readonly amount: number; readonly target: string };
  readonly escalatedPaysZero: boolean;
  readonly orderOfReview: readonly string[];
  readonly recognized: readonly RecognizedClause[];
  readonly unrecognized: readonly UnrecognizedClause[];
  /** decision-rule sentences seen / understood — the headline number of the review report */
  readonly decisionSentences: number;
}

const NORMATIVE =
  /\b(must|shall|never|only|escalat\w*|den(?:y|ied|ies)|payable|not (?:be )?(?:paid|compensable|excluded)|is excluded|within|at least|more than|no (?:deductible|declared)|routed|referred|approv\w*|reimburs\w*|regardless|no matter|requires?|prohibited|forbidden|may not|cannot)\b|\$\d/i;
const num = (s: string): number => Number(s.replace(/,/g, ''));
const titleCase = (s: string): string => s.trim();
const ruleTag = (e: PolicyEntry): string => /\((R\d+)\)/.exec(`${e.section} ${e.title}`)?.[1] ?? '';

export function extractRules(entries: readonly PolicyEntry[]): RuleSet {
  const gates: GateClause[] = [];
  const windows: WindowClause[] = [];
  const recognized: RecognizedClause[] = [];
  const unrecognized: UnrecognizedClause[] = [];
  let extension: RuleSet['extension'];
  let packagingExclusion = false;
  let minDelayDays: number | undefined;
  let weatherExcludedDays: number | undefined;
  let delay: RuleSet['delay'];
  let perishableOnly = false;
  let noLogTarget: string | undefined;
  let toleranceHours: number | undefined;
  const rates: { cls: string; perLb: number }[] = [];
  let baseValueRule = false;
  let deductible: number | undefined;
  let fullCoverageWaivesDeductible = false;
  let lossIsTotal = false;
  let threshold: RuleSet['threshold'];
  let escalatedPaysZero = false;
  let orderOfReview: string[] = [];
  let decisionSentences = 0;

  for (const e of entries) {
    const rule = ruleTag(e);
    if (rule === '') continue; // only sections tagged as rules (R1…) are decision rules; background/handbook entries are knowledge only
    for (const s of e.sentences) {
      const note = (kind: string): void => void recognized.push({ kind, rule, sentence: s });
      let hit = false;
      const m = (re: RegExp): RegExpExecArray | null => re.exec(s);
      let x: RegExpExecArray | null;

      if ((x = m(/commodity class is (\w+)\b.*?\bescalated to (?:the )?([A-Z][A-Za-z ]+?)(?:,|\.|$)/))) {
        gates.push({ rule, variable: 'commodity_class', op: '==', value: x[1]!.toLowerCase(), target: titleCase(x[2]!), sentence: s });
        note('gate');
        hit = true;
      } else if (
        (x = m(/(\d+) or more earlier claims in the previous (\d+) days.*?escalate the claim to the (\w[\w ]*?) (?:\(|before|\.|,)/))
      ) {
        gates.push({ rule, variable: `claimant_claims_last_${x[2]}d`, op: '>=', value: num(x[1]!), target: titleCase(x[3]!), sentence: s });
        note('gate');
        hit = true;
      } else if (
        (x = m(
          /\b(\w+) (?:claim|request|report)s?(?: \([^)]*\))? must be (?:filed|submitted) within (\d+) days (?:after|of) (?:the )?([\w ]+?)\.?$/i,
        ))
      ) {
        windows.push({
          selector: 'claim_type',
          kind: x[1]!.toLowerCase(),
          days: num(x[2]!),
          event: x[3]!.toLowerCase().replace(/\.$/, ''),
        });
        note('window');
        hit = true;
      } else if ((x = m(/damage was noted on the proof of delivery.*?extended to (\d+) days/i))) {
        extension = { days: num(x[1]!), variable: 'pod_damage_noted', appliesTo: 'damage' };
        note('window_extension');
        hit = true;
      } else if (/packed the freight and the packaging was inadequate/i.test(s)) {
        packagingExclusion = true;
        note('exclusion');
        hit = true;
      } else if (/never excluded for packaging/i.test(s)) {
        note('exclusion_carve_out');
        hit = true;
      } else if ((x = m(/only payable when delivery was at least (\d+) days late/i))) {
        minDelayDays = num(x[1]!);
        note('delay_minimum');
        hit = true;
      } else if (/less than (\d+) days? is denied/i.test(s) && minDelayDays !== undefined) {
        note('delay_minimum');
        hit = true;
      } else if ((x = m(/first (\d+) days of delay are not compensable/i))) {
        weatherExcludedDays = num(x[1]!);
        note('weather_exclusion');
        hit = true;
      } else if (/weather delay of (\d+) days or less is denied/i.test(s)) {
        note('weather_exclusion');
        hit = true;
      } else if ((x = m(/\$([\d,.]+) per compensable day, up to a maximum of (\d+) days/i))) {
        delay = { perDay: num(x[1]!), maxDays: num(x[2]!) };
        note('delay_pay');
        hit = true;
      } else if (/no deductible and no declared-value logic apply to delay claims/i.test(s)) {
        note('delay_pay');
        hit = true;
      } else if (/only payable for perishable freight/i.test(s)) {
        perishableOnly = true;
        note('temperature');
        hit = true;
      } else if (
        (x = m(/if no log is available, escalate to the ([A-Z][A-Za-z ]+?)\./i)) ||
        (x = m(/log must be available.*?escalate to the ([A-Z][A-Za-z ]+?)\./i))
      ) {
        noLogTarget = titleCase(x[1]!);
        note('temperature');
        hit = true;
      } else if ((x = m(/excursion of (\d+) hours or less/i))) {
        toleranceHours = num(x[1]!);
        note('temperature');
        hit = true;
      } else if (/paid as a total loss/i.test(s)) {
        note('temperature');
        hit = true;
      } else if (/liability cap is the affected weight/i.test(s)) {
        for (const r of s.matchAll(/(?:^|[:,]\s*|\band\s+)([a-z][a-z ]*?) \$([\d.]+) per lb/g)) {
          rates.push({ cls: r[1]!.trim().replace(/\s+/g, '_'), perLb: num(r[2]!) });
        }
        if (rates.length > 0) {
          note('rates');
          hit = true;
        }
      } else if (/base value is the lesser of the declared value and the liability cap/i.test(s)) {
        baseValueRule = true;
        note('base_value');
        hit = true;
      } else if (
        /full value coverage endorsement.*base value is the declared value|no value was declared, the base value is the liability cap/i.test(
          s,
        )
      ) {
        note('base_value');
        hit = true;
      } else if (/loss is the base value multiplied by the damage percentage/i.test(s)) {
        note('net_loss');
        hit = true;
      } else if (/loss and temperature claims are treated as 100% damage/i.test(s)) {
        lossIsTotal = true;
        note('net_loss');
        hit = true;
      } else if ((x = m(/deductible of \$([\d,.]+) per claim is subtracted.*?unless the shipment has full value coverage/i))) {
        deductible = num(x[1]!);
        fullCoverageWaivesDeductible = true;
        note('deductible');
        hit = true;
      } else if (/does not exceed the deductible the claim is denied|partial settlement/i.test(s)) {
        note('deductible');
        hit = true;
      } else if ((x = m(/(?:payout|amount|total)[\w ]*? is more than \$([\d,]+), escalate to the ([A-Z][A-Za-z ]+?)(?:;|\.|,)/i))) {
        threshold = { amount: num(x[1]!), target: titleCase(x[2]!) };
        note('threshold');
        hit = true;
      } else if (/escalated claims are not paid by the (?:desk|team)/i.test(s)) {
        escalatedPaysZero = true;
        note('escalated_pays_zero');
        hit = true;
      } else if (/review every claim in this order/i.test(s)) {
        orderOfReview = [...s.matchAll(/\(\d+\)\s*([^,()]+?)(?=,|\.|$)/g)].map((r) => r[1]!.trim().replace(/^and\s+/, ''));
        note('order');
        hit = true;
      } else if (
        /(?:earlier|earlier rule|later rule|this check comes last|filed after its window is denied as late|never pays or denies)/i.test(s)
      ) {
        note('explanatory');
        hit = true;
      }

      if (NORMATIVE.test(s) || hit) {
        decisionSentences++;
        if (!hit) unrecognized.push({ rule, section: e.section, sentence: s });
      }
    }
  }

  return {
    gates,
    windows,
    ...(extension !== undefined ? { extension } : {}),
    packagingExclusion,
    ...(minDelayDays !== undefined ? { minDelayDays } : {}),
    ...(weatherExcludedDays !== undefined ? { weatherExcludedDays } : {}),
    ...(delay !== undefined ? { delay } : {}),
    temperature: {
      perishableOnly,
      ...(noLogTarget !== undefined ? { noLogTarget } : {}),
      ...(toleranceHours !== undefined ? { toleranceHours } : {}),
    },
    rates,
    baseValueRule,
    ...(deductible !== undefined ? { deductible } : {}),
    fullCoverageWaivesDeductible,
    lossIsTotal,
    ...(threshold !== undefined ? { threshold } : {}),
    escalatedPaysZero,
    orderOfReview,
    recognized,
    unrecognized,
    decisionSentences,
  };
}
