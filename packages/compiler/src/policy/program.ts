/**
 * Policy program: the domain-neutral intermediate form between a policy document and an executable decision tree.
 *
 *   document ──(clause extraction: patterns and/or a checked model proposal)──▶ PolicyProgram ──(build)──▶ DecisionTree
 *
 * A program is an ordered list of steps over a set of declared facts:
 *   gate    "when <condition>, the outcome is <decision>"            (deny / escalate / hold …)
 *   assign  "<name> is <expression>"                                 (a quantity the later steps use)
 *   finish  "when <condition>, the outcome is <decision> paying <amount>"
 * Every step may be scoped to some values of one categorical fact (the "kind" of case). Nothing in this file, or in
 * the builder that consumes it, knows what a claim, a freight shipment or an expense report is.
 */

export type FactType = 'number' | 'boolean' | 'string';

export interface PolicyFact {
  readonly name: string;
  readonly type: FactType;
  readonly description: string;
  readonly enum?: readonly string[];
  /** normally computed from case text (a day count between two dates) rather than quoted */
  readonly derivable?: boolean;
}

export interface StepSource {
  /** rule tag from the document ("R3"), or '' when the document has none */
  readonly rule: string;
  readonly section: string;
  /** the exact sentence the step was read from — the evidence a reviewer checks */
  readonly sentence: string;
}

export type StepOrigin = 'pattern' | 'model' | 'operator';

export interface Outcome {
  readonly decision: string;
  readonly target?: string;
  readonly reason: string;
}

/** The categorical fact whose values scope a step: the step applies only when `var` is one of `values`. */
export interface Scope {
  readonly var: string;
  readonly values: readonly string[];
}

interface StepBase {
  readonly id: string;
  /** position in the document (stable tie-break) */
  readonly order: number;
  readonly scope?: Scope;
  readonly note: string;
  readonly source: StepSource;
  readonly origin: StepOrigin;
  /** a step that values the case; other kinds the document says are "treated as" kind X inherit it (see extract.ts) */
  readonly valuation?: boolean;
}

export interface GateStep extends StepBase {
  readonly kind: 'gate';
  readonly when: string;
  readonly outcome: Outcome;
}
export interface AssignStep extends StepBase {
  readonly kind: 'assign';
  /** one or more `name = expression` definitions evaluated in order */
  readonly set: Readonly<Record<string, string>>;
}
export interface FinishStep extends StepBase {
  readonly kind: 'finish';
  readonly when?: string;
  readonly outcome: Outcome;
  /** expression for the amount paid, evaluated when the step fires */
  readonly amount?: string;
}
export type Step = GateStep | AssignStep | FinishStep;

export interface PolicyProgram {
  readonly title: string;
  readonly facts: readonly PolicyFact[];
  readonly steps: readonly Step[];
  /** the categorical fact that selects the case kind (e.g. "claim_type"), if the document distinguishes kinds */
  readonly kindVar?: string;
  readonly kinds: readonly string[];
  /** name of the numeric output field (e.g. "payout_usd"), if the document pays an amount */
  readonly amountField?: string;
  /** statements the document makes that hold regardless of path (authority limits, zero payout on escalation) */
  readonly invariants: readonly Invariant[];
  /** things the document says must never be done */
  readonly prohibitions: readonly Prohibition[];
  /** ordered review list when the document states one */
  readonly reviewOrder: readonly string[];
  /** lookup tables read from the document's tables (each also appears as an assign step) */
  readonly tables?: readonly LookupTable[];
}

export interface LookupTable {
  readonly caption: string;
  /** fact the rows are keyed by */
  readonly key: string;
  /** the table's own wording for the key column ("Invoice tier"), used to match a sentence that refers to it */
  readonly keyPhrase: string;
  /** quantity the lookup defines */
  readonly value: string;
  readonly rows: readonly { readonly key: string; readonly value: number }[];
}

export type Invariant =
  | { readonly kind: 'authority_limit'; readonly limit: number; readonly target: string; readonly sentence: string }
  | { readonly kind: 'zero_amount_on'; readonly decisions: readonly string[]; readonly sentence: string };

export interface Prohibition {
  readonly text: string;
  readonly sentence: string;
  readonly rule: string;
}

// ── naming ─────────────────────────────────────────────────────────────────────────────────────────────────────

const DETERMINERS = new Set([
  'the',
  'a',
  'an',
  'any',
  'each',
  'every',
  'that',
  'this',
  'these',
  'those',
  'such',
  'its',
  'their',
  'his',
  'her',
  'our',
  'your',
  'all',
  'some',
]);
const UNIT_WORDS: Readonly<Record<string, string>> = {
  pounds: 'lb',
  pound: 'lb',
  lbs: 'lb',
  kilograms: 'kg',
  kilogram: 'kg',
  dollars: 'usd',
  dollar: 'usd',
  percent: 'pct',
  percentage: 'pct',
};
export const MONEY_NOUNS = new Set([
  'value',
  'amount',
  'cost',
  'price',
  'payout',
  'fee',
  'balance',
  'charge',
  'limit',
  'total',
  'premium',
  'salary',
  'income',
  'reimbursement',
  'refund',
  'payment',
  'benefit',
]);

export const wordsOf = (phrase: string): string[] =>
  phrase
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

/** crude singular form, good enough to match "claims"/"claim", "delays"/"delay" */
export const singular = (w: string): string =>
  w.length > 3 && w.endsWith('ies')
    ? `${w.slice(0, -3)}y`
    : w.length > 3 && /(?:ss|us|is)$/.test(w)
      ? w
      : w.length > 3 && w.endsWith('s')
        ? w.slice(0, -1)
        : w;

/** "filed" → "file", "submitted" → "submit", "claimed" → "claim" */
const IRREGULAR: Readonly<Record<string, string>> = {
  paid: 'pay',
  sent: 'send',
  made: 'make',
  given: 'give',
  taken: 'take',
  done: 'do',
  written: 'write',
  bought: 'buy',
  sold: 'sell',
  held: 'hold',
  kept: 'keep',
  left: 'leave',
  lost: 'lose',
  met: 'meet',
  told: 'tell',
  brought: 'bring',
};

export function verbStem(verb: string): string {
  const v = verb.toLowerCase();
  if (IRREGULAR[v] !== undefined) return IRREGULAR[v]!;
  if (!v.endsWith('ed')) return v;
  if (v.endsWith('ied')) return `${v.slice(0, -3)}y`;
  const dropD = v.slice(0, -1);
  if (/[^aeiou][aeiou][^aeiouwxy]e$/.test(dropD)) return dropD;
  const base = v.slice(0, -2);
  return /([^aeiou])\1$/.test(base) ? base.slice(0, -1) : base;
}

/** a phrase as identifier tokens: determiners dropped, unit words normalised ("in pounds" → "lb") */
export function nameTokens(phrase: string, max = 6): string[] {
  const t = wordsOf(phrase).filter((w) => !DETERMINERS.has(w));
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!;
    if (w === 'in' && t[i + 1] !== undefined && UNIT_WORDS[t[i + 1]!] !== undefined) {
      out.push(UNIT_WORDS[t[i + 1]!]!);
      i++;
      continue;
    }
    out.push(UNIT_WORDS[w] ?? w);
  }
  return out.slice(0, max);
}

export const identifier = (phrase: string, max = 6): string => {
  const id = nameTokens(phrase, max).join('_');
  return /^[a-z]/.test(id) ? id : `f_${id}`;
};

export const upperCode = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

export const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
export const fmtNum = (n: number): string => String(n);

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  sixty: 60,
  ninety: 90,
};
/** "30", "1,200", "twelve" → number; undefined if it is not one */
export function toNumber(s: string): number | undefined {
  const t = s.trim().toLowerCase().replace(/,/g, '');
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return NUMBER_WORDS[t];
}

/** identifiers an expression reads (function names and literals excluded) */
export function identifiersIn(expr: string): string[] {
  const stripped = expr.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, ' ');
  const out = new Set<string>();
  for (const m of stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const id = m[0];
    const after = stripped.slice((m.index ?? 0) + id.length).trimStart();
    if (after.startsWith('(')) continue; // function call
    if (id === 'true' || id === 'false' || id === 'null') continue;
    out.add(id);
  }
  return [...out];
}

// ── facts ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FactOptions {
  readonly description?: string;
  readonly enumValue?: string;
  readonly derivable?: boolean;
  readonly forceName?: string;
}

/**
 * The set of facts a document introduces. Facts are named from the document's own words, and a later mention of
 * the same thing ("Full Value Coverage" after "a Full Value Coverage endorsement") resolves to the fact already
 * declared instead of creating a duplicate.
 */
export class FactRegistry {
  private readonly byName = new Map<
    string,
    { type: FactType; description: string; enums: string[]; derivable: boolean; tokens: Set<string>; closed: boolean }
  >();
  private readonly moneyDoc: boolean;

  constructor(documentText: string) {
    this.moneyDoc = /\$\s?\d/.test(documentText);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** the fact whose name tokens contain every token of `phrase` (or vice versa, with ≥2 shared), if any */
  find(phrase: string): string | undefined {
    const want = new Set(nameTokens(phrase).map(singular));
    if (want.size === 0) return undefined;
    let best: { name: string; score: number } | undefined;
    for (const [name, f] of this.byName) {
      const have = new Set([...f.tokens].map(singular));
      let shared = 0;
      for (const w of want) if (have.has(w)) shared++;
      const score = shared / Math.max(want.size, have.size);
      const contained = shared === want.size || (shared === have.size && shared >= 2);
      if (contained || score >= 0.75) if (best === undefined || score > best.score) best = { name, score };
    }
    return best?.name;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  declare(phrase: string, type: FactType, opts: FactOptions = {}): string {
    const existing = opts.forceName === undefined ? this.find(phrase) : undefined;
    const name = existing ?? opts.forceName ?? this.nameFor(phrase, type);
    const cur = this.byName.get(name);
    if (cur === undefined) {
      this.byName.set(name, {
        type,
        description: opts.description ?? phrase.trim(),
        enums: opts.enumValue !== undefined ? [opts.enumValue] : [],
        derivable: opts.derivable === true,
        tokens: new Set(nameTokens(phrase)),
        closed: false,
      });
    } else if (opts.enumValue !== undefined && !cur.enums.includes(opts.enumValue)) cur.enums.push(opts.enumValue);
    return name;
  }

  setDescription(name: string, description: string): void {
    const f = this.byName.get(name);
    if (f !== undefined) f.description = description;
  }

  /** record a value the document names for a fact; `close` says the document lists the COMPLETE set (a table, the case kinds) */
  addEnum(name: string, value: string, close = false): void {
    const f = this.byName.get(name);
    if (f === undefined) return;
    if (!f.enums.includes(value)) f.enums.push(value);
    if (close) f.closed = true;
  }

  private nameFor(phrase: string, type: FactType): string {
    let id = identifier(phrase);
    const last = nameTokens(phrase).slice(-1)[0] ?? '';
    if (type === 'number' && this.moneyDoc && MONEY_NOUNS.has(last) && !/_(?:usd|pct|lb|kg)$/.test(id)) id = `${id}_usd`;
    let n = id;
    let i = 2;
    while (this.byName.has(n)) n = `${id}_${i++}`;
    return n;
  }

  list(): PolicyFact[] {
    return [...this.byName.entries()].map(([name, f]) => ({
      name,
      type: f.type,
      description: f.enums.length > 0 && !f.closed ? `${f.description} (the document singles out: ${f.enums.join(', ')})` : f.description,
      ...(f.enums.length > 0 && f.closed ? { enum: [...f.enums] } : {}),
      ...(f.derivable ? { derivable: true } : {}),
    }));
  }
}
