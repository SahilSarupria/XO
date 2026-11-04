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

/** Word-for-word comparison that ignores case, punctuation and spacing (a model often drops a bracket or full stop when quoting). */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const MONTHS =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\b\d{4}-\d{2}-\d{2}\b/gi;

/** Whole-day differences between every pair of dates found in the quotes (used to verify a derived day count). */
function dayDiffs(quotes: readonly string[]): number[] {
  const ds: number[] = [];
  for (const m of quotes.join(' ; ').matchAll(MONTHS)) {
    const t = Date.parse(/\d{4}/.test(m[0]) ? `${m[0]} UTC` : `${m[0]}, 2000 UTC`);
    if (Number.isFinite(t)) ds.push(t);
  }
  const out: number[] = [];
  for (let i = 0; i < ds.length; i++)
    for (let j = i + 1; j < ds.length; j++) out.push(Math.round(Math.abs((ds[i] as number) - (ds[j] as number)) / 86_400_000));
  return out;
}

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
    let raw: unknown = ev[input.name];
    if (typeof raw === 'string') {
      const text: string = raw;
      // tolerate a model that sends the evidence object as JSON text, or as the bare quote
      try {
        const parsed: unknown = JSON.parse(text);
        raw = typeof parsed === 'object' && parsed !== null ? parsed : { quote: text };
      } catch {
        raw = { quote: text.replace(/^\s*quote\s*:\s*/i, '') };
      }
    }
    // A classification into a closed set of labels (claim_type, packaging…) is a judgement about the text, not a quotable
    // span: evidence is optional there, but a quote that IS given must still be verbatim.
    const classification = input.enum !== undefined && input.enum.length > 0;
    if ((typeof raw !== 'object' || raw === null) && classification) continue;
    if (typeof raw !== 'object' || raw === null) {
      bad.push({
        field: input.name,
        reason: 'no_evidence',
        detail: `no evidence quote given for ${input.name}; if the case does not state it, do not supply it`,
      });
      continue;
    }
    const e = raw as { quote?: unknown; derived?: unknown };
    // "…" / "..." lets the model quote several separate fragments in one string; each fragment must be verbatim.
    const quotes = (typeof e.quote === 'string' ? [e.quote] : Array.isArray(e.quote) ? e.quote : [])
      .filter((q): q is string => typeof q === 'string')
      .flatMap((q) => q.split(/\.{3}|\u2026/))
      .filter((q) => norm(q).length >= 3);
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
    // Computed quantities (inputs the tree marks derivable, e.g. a day count) are verified against the quoted dates when two or more
    // dates are given; otherwise the quotes must contain at least two figures to compute from. A `derived` flag on any other input is ignored.
    const derived = input.derivable === true && typeof value === 'number';
    if (derived) {
      const diffs = dayDiffs(quotes);
      const figures = new Set(quotes.flatMap(numbersIn)).size;
      const stated = quotes.flatMap(numbersIn).includes(value as number); // the quote simply states it ("ran warm for about 0 hrs")
      const consistent = stated || (diffs.length > 0 ? diffs.includes(value as number) : figures >= 2);
      if (!consistent)
        bad.push({
          field: input.name,
          reason: 'value_not_in_quote',
          detail: `${input.name}=${value} does not follow from the quoted figures${diffs.length > 0 ? ` (day differences between the quoted dates: ${[...new Set(diffs)].join(', ')})` : ''}; quote the dates or times it was computed from`,
        });
      continue;
    }
    if (typeof value === 'number' && !derived) {
      if (value === 0) continue; // "nothing stated", "no earlier claims", "first contact": zero is supported by an absence statement, which is a verbatim quote
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
