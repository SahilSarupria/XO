import type { DecisionTree } from './decision-tree.js';

/**
 * Fact grounding: a model that calls a decision tree can invent an input (a "plausible default") and the
 * tree will happily compute from it. When grounding is required, every fact the model supplies must come
 * with `evidence` — a verbatim quote from the case text — and numeric facts must match a number in that quote
 * unless the model marks them `derived` (e.g. a day count computed from two quoted dates).
 *
 * What this stops: an input with no support in the text (the model has to say it is missing, so the case escalates).
 * What it does not stop: a model that quotes real text and misreads it, or marks an invented value `derived`
 * and quotes unrelated text. It makes fabrication visible and costly, not impossible; see docs/LAYER_CONTRACT.md.
 */
export interface FactEvidence {
  readonly quote: string | readonly string[];
  readonly derived?: boolean;
}

export interface UngroundedFact {
  readonly field: string;
  readonly reason: 'no_evidence' | 'quote_not_in_text' | 'value_not_in_quote';
  readonly detail: string;
}

export type GroundingResult = { readonly ok: true } | { readonly ok: false; readonly ungrounded: readonly UngroundedFact[] };

const WORDS: Record<string, number> = {
  no: 0,
  none: 0,
  zero: 0,
  one: 1,
  a: 1,
  an: 1,
  single: 1,
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
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

function numbersIn(quote: string): number[] {
  const out: number[] = [];
  for (const m of quote.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  for (const w of norm(quote).split(/[^a-z]+/)) if (w in WORDS) out.push(WORDS[w] as number);
  return out;
}

export function checkGrounding(
  tree: DecisionTree,
  facts: Readonly<Record<string, unknown>>,
  evidence: unknown,
  sourceText: string,
): GroundingResult {
  const haystack = norm(sourceText);
  const ev = typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence) ? (evidence as Record<string, unknown>) : {};
  const bad: UngroundedFact[] = [];
  for (const input of tree.inputs) {
    if (!(input.name in facts) || facts[input.name] === null || facts[input.name] === undefined) continue;
    const value = facts[input.name];
    const raw = ev[input.name];
    if (typeof raw !== 'object' || raw === null) {
      bad.push({
        field: input.name,
        reason: 'no_evidence',
        detail: `no evidence quote given for ${input.name}; if the case does not state it, do not supply it`,
      });
      continue;
    }
    const e = raw as { quote?: unknown; derived?: unknown };
    const quotes = (typeof e.quote === 'string' ? [e.quote] : Array.isArray(e.quote) ? e.quote : []).filter(
      (q): q is string => typeof q === 'string' && norm(q).length >= 3,
    );
    if (quotes.length === 0) {
      bad.push({ field: input.name, reason: 'no_evidence', detail: `empty evidence quote for ${input.name}` });
      continue;
    }
    const missing = quotes.find((q) => !haystack.includes(norm(q)));
    if (missing !== undefined) {
      bad.push({
        field: input.name,
        reason: 'quote_not_in_text',
        detail: `quote for ${input.name} does not appear verbatim in the case text`,
      });
      continue;
    }
    if (typeof value === 'number' && e.derived !== true) {
      const nums = quotes.flatMap(numbersIn);
      if (!nums.some((n) => Math.abs(n - value) < 1e-9))
        bad.push({
          field: input.name,
          reason: 'value_not_in_quote',
          detail: `${input.name}=${value} is not a number in its quote; if you computed it from the quote, set derived: true`,
        });
    }
  }
  return bad.length === 0 ? { ok: true } : { ok: false, ungrounded: bad };
}
