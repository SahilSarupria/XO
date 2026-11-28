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
  readonly reason: 'no_evidence' | 'quote_not_in_text' | 'value_not_in_quote' | 'quote_off_topic' | 'quote_does_not_support_value' | 'conflicting_evidence' | 'derivation_mismatch' | 'no_provenance' | 'untrusted_source';
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

const MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const monthIndex = (m: string): number => MON.split('|').indexOf(m.slice(0, 3).toLowerCase());
const validDate = (y: number, mo: number, d: number): number => {
  const t = Date.UTC(y, mo, d);
  const dt = new Date(t);
  return mo >= 0 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? t : Number.NaN;
};
/** Full calendar dates (with a year) in a quote: "March 3, 2026", "3 March 2026", "2026-03-03". A date without a year is not a date here. */
function fullDates(q: string): number[] {
  const out: number[] = [];
  for (const m of q.matchAll(new RegExp(`\\b(${MON})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) out.push(validDate(+m[3]!, monthIndex(m[1]!), +m[2]!));
  for (const m of q.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})[a-z]*\\.?,?\\s+(\\d{4})\\b`, 'gi'))) out.push(validDate(+m[3]!, monthIndex(m[2]!), +m[1]!));
  for (const m of q.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(validDate(+m[1]!, +m[2]! - 1, +m[3]!));
  return out.filter((t) => Number.isFinite(t));
}

const MAX_QUOTE_CHARS = 200;
const STOP = new Set(['number', 'this', 'that', 'with', 'from', 'were', 'only', 'there', 'case', 'says', 'stated', 'leave', 'give', 'which', 'what', 'have', 'been', 'does', 'text', 'than', 'then', 'when']);
const stem = (w: string): string => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
/** Words that name what a field is about (from its name and description); a zero must be stated in a quote about that topic. */
function fieldTokens(input: { readonly name: string; readonly description?: string; readonly evidenceCues?: readonly string[] }): Set<string> {
  const words = `${input.name.replace(/_/g, ' ')} ${input.description ?? ''}`.toLowerCase().split(/[^a-z]+/);
  const toks = new Set(words.filter((w) => w.length >= 4 && !STOP.has(w)).map(stem));
  // vocabulary the knowledge base (or the tree) supplies for this input also counts as topical ("hrs" for hours)
  for (const c of input.evidenceCues ?? []) for (const w of c.toLowerCase().split(/[^a-z]+/)) if (w.length >= 2 && !STOP.has(w)) toks.add(stem(w));
  return toks;
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
    if (input.valueEvidence !== undefined) {
      // Typed evidence: the case text itself must say the supplied value, and must not also say a different one.
      const says = (v: unknown): boolean => input.valueEvidence!.some((e) => e.value === v && e.patterns.some((p) => new RegExp(p).test(haystack)));
      const supplied = says(value);
      const others = input.valueEvidence.filter((e) => e.value !== value && e.patterns.some((p) => new RegExp(p).test(haystack))).map((e) => JSON.stringify(e.value));
      if (!supplied) {
        bad.push({
          field: input.name,
          reason: 'quote_does_not_support_value',
          detail: others.length > 0 ? `the case text says ${others.join(' / ')} for ${input.name}, not ${JSON.stringify(value)}` : `nothing in the case text states ${JSON.stringify(value)} for ${input.name}; if it does not say, leave it out as unknown`,
        });
        continue;
      }
      if (others.length > 0) {
        bad.push({
          field: input.name,
          reason: 'conflicting_evidence',
          detail: `the case text states both ${JSON.stringify(value)} and ${others.join(' / ')} for ${input.name}: a self-contradicting case is escalated, not resolved by picking one`,
        });
        continue;
      }
    }
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
      if (classification) continue; // empty evidence on a fixed-label classification is the same as none: not a refusal (a quote that IS given is still checked below)
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
      // a cue must start a word ("rain" matches "rainfall", not "train"; "palletis" matches "palletised")
      const cues = input.evidenceCues.map((c) => new RegExp(`\\b${norm(c).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      if (!quotes.some((q) => cues.some((c) => c.test(norm(q))))) {
        bad.push({
          field: input.name,
          reason: 'quote_off_topic',
          detail: `the quote for ${input.name} is not about it (expected it to mention one of: ${input.evidenceCues.join(', ')}); if the case does not say, leave it out as unknown`,
        });
        continue;
      }
    }
    if (input.valueEvidence !== undefined) {
      // the text already states the supplied value (checked above); the quote must not be a clause that says something else
      const contra = input.valueEvidence.find((e) => e.value !== value && quotes.some((q) => e.patterns.some((p) => new RegExp(p).test(norm(q)))));
      if (contra !== undefined) {
        bad.push({ field: input.name, reason: 'quote_does_not_support_value', detail: `the quote for ${input.name} says ${JSON.stringify(contra.value)}, not ${JSON.stringify(value)}` });
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
    const derived = input.derivation?.kind === 'days_between' && typeof value === 'number';
    if (derived) {
      // Recomputed here, never trusted: exactly two distinct full dates, and value = whole calendar days between them.
      const stated = quotes.flatMap(numbersIn).includes(value as number); // the quote itself states it ("filed 12 days after delivery")
      if (!stated) {
        // exactly two date mentions in the quotes; a 0-day difference (same date twice) additionally needs the case text itself to state that date twice
        const dates = quotes.flatMap(fullDates).sort((x, y) => x - y);
        const inText = fullDates(sourceText);
        const sameDayOk = dates.length === 2 && dates[0] !== dates[1] ? true : dates.length === 2 && inText.filter((t) => t === dates[0]).length >= 2;
        const days = dates.length === 2 && sameDayOk ? Math.round((dates[1]! - dates[0]!) / 86_400_000) : undefined;
        if (days === undefined || days !== value)
          bad.push({
            field: input.name,
            reason: 'derivation_mismatch',
            detail:
              days === undefined
                ? `${input.name} is computed from exactly two full dates (with a year); your quotes contain ${dates.length} usable date mention(s). Quote just the two dates`
                : `${input.name}=${value} but the quoted dates are ${days} day(s) apart`,
          });
      }
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
 * or the fact value `"unknown"` / `null`. `{ status: 'conflicting' }` (the case states two different values) is handled the same way: the fact is withheld, the tree returns missing_facts, the case escalates. Such facts are removed before the tree runs, so the tree returns missing_facts and the
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
    const st = typeof e === 'object' && e !== null ? (e as { status?: unknown }).status : undefined;
    const flagged = st === 'unknown' || st === 'conflicting';
    const asText = typeof v === 'string' && ['unknown', 'unspecified', 'not stated', 'n/a', ''].includes(v.trim().toLowerCase());
    if (flagged || asText || v === null || v === undefined) unknown.push(k);
    else kept[k] = v;
  }
  return { facts: kept, unknown };
}

/** Where a structured fact came from. Structured inputs are held to the same standard as model-extracted ones. */
export interface FactProvenance {
  /** 'system_of_record' and 'form_field' must name a source on the operator's trusted list; 'document_span' is verified against the case text. */
  readonly kind: 'system_of_record' | 'form_field' | 'document_span';
  readonly source: string;
  readonly ref?: string;
  /** document_span only: exact words from the case text that state the value (same rules as model evidence). */
  readonly quote?: string | readonly string[];
}

/**
 * Admits only the structured facts that carry acceptable provenance: no provenance, an untrusted source, or a document span that
 * does not check out all withhold the fact (the tree then reports it missing and the case falls back or escalates).
 */
export function checkProvenance(
  tree: DecisionTree,
  facts: Readonly<Record<string, unknown>>,
  provenance: Readonly<Record<string, FactProvenance>> | undefined,
  opts: { readonly trustedSources: readonly string[]; readonly text?: string },
): { readonly accepted: Record<string, unknown>; readonly rejected: readonly UngroundedFact[] } {
  const accepted: Record<string, unknown> = {};
  const rejected: UngroundedFact[] = [];
  for (const [field, value] of Object.entries(facts)) {
    const p = provenance?.[field];
    if (p === undefined) {
      rejected.push({ field, reason: 'no_provenance', detail: `structured fact ${field} has no provenance (source system or document span)` });
      continue;
    }
    if (p.kind === 'document_span') {
      const g = checkGrounding(tree, { [field]: value }, { [field]: { quote: p.quote ?? '' } }, opts.text ?? '');
      if (!g.ok) {
        rejected.push(...g.ungrounded);
        continue;
      }
      accepted[field] = value;
      continue;
    }
    if (!opts.trustedSources.includes(p.source)) {
      rejected.push({ field, reason: 'untrusted_source', detail: `${field} comes from "${p.source}", which is not on this layer's trusted fact sources` });
      continue;
    }
    accepted[field] = value;
  }
  return { accepted, rejected };
}
