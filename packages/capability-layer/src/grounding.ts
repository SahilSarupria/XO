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
  readonly reason: 'no_evidence' | 'quote_not_in_text' | 'value_not_in_quote' | 'quote_off_topic';
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

const MAX_QUOTE_CHARS = 200;
const STOP = new Set(['number', 'this', 'that', 'with', 'from', 'were', 'only', 'there', 'case', 'says', 'stated', 'leave', 'give', 'which', 'what', 'have', 'been', 'does', 'text', 'than', 'then', 'when']);
const stem = (w: string): string => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
/** Words that name what a field is about (from its name and description); a zero must be stated in a quote about that topic. */
function fieldTokens(input: { readonly name: string; readonly description?: string }): Set<string> {
  const words = `${input.name.replace(/_/g, ' ')} ${input.description ?? ''}`.toLowerCase().split(/[^a-z]+/);
  return new Set(words.filter((w) => w.length >= 4 && !STOP.has(w)).map(stem));
}
const ABSENCE = /\b(?:0|zero|no|none|nil|not|never|nothing|without|first)\b/;

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
    // A quote must be a clause, not the whole claim: pasting the entire text as "evidence" makes every value look supported.
    const tooLong = quotes.find((q) => q.length > MAX_QUOTE_CHARS);
    if (tooLong !== undefined) {
      bad.push({
        field: input.name,
        reason: 'value_not_in_quote',
        detail: `quote for ${input.name} is ${tooLong.length} characters; quote only the short clause that states it (max ${MAX_QUOTE_CHARS})`,
      });
      continue;
    }
    if (input.evidenceCues !== undefined && input.evidenceCues.length > 0) {
      const cues = input.evidenceCues.map(norm);
      if (!quotes.some((q) => cues.some((c) => norm(q).includes(c)))) {
        bad.push({
          field: input.name,
          reason: 'quote_off_topic',
          detail: `the quote for ${input.name} is not about it (expected it to mention one of: ${input.evidenceCues.join(', ')}); if the case does not say, leave it out as unknown`,
        });
        continue;
      }
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
      if (value === 0) {
        // Zero is the default a model reaches for when a figure is simply not stated ("0 if none"), so a verbatim quote alone is not
        // enough: the quote must itself say there were none (a 0, "no", "none", "not", "first", "nothing"...). Unrelated real text fails.
        const topical = fieldTokens(input);
        if (!quotes.some((q) => ABSENCE.test(norm(q)) && norm(q).split(' ').some((w) => topical.has(stem(w))))) {
          bad.push({
            field: input.name,
            reason: 'value_not_in_quote',
            detail: `${input.name}=0 needs a quote that states there were none (e.g. "no earlier claims"); if the case does not say, leave it out as unknown`,
          });
        }
        continue;
      }
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

/**
 * Explicit unknown state. A model may report a fact as unknown instead of guessing: `evidence[field] = { status: 'unknown' }`
 * or the fact value `"unknown"` / `null`. Such facts are removed before the tree runs, so the tree returns missing_facts and the
 * case escalates. This keeps "unknown" distinct from 0, "", false: it can never be coerced into a value.
 */
export function stripUnknown(
  facts: Readonly<Record<string, unknown>>,
  evidence: unknown,
): { readonly facts: Record<string, unknown>; readonly unknown: readonly string[] } {
  const ev = typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence) ? (evidence as Record<string, unknown>) : {};
  const kept: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(facts)) {
    const e = ev[k];
    const flagged = typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 'unknown';
    const asText = typeof v === 'string' && ['unknown', 'unspecified', 'not stated', 'n/a', ''].includes(v.trim().toLowerCase());
    if (flagged || asText || v === null || v === undefined) unknown.push(k);
    else kept[k] = v;
  }
  return { facts: kept, unknown };
}
