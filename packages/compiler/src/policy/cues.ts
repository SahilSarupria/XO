import type { TreeInput } from '@xo/capability-layer';

/**
 * Automatic evidence cues for compiled tree inputs. A cue marks claim text as being ABOUT an input, so the runtime can refuse a
 * real-but-unrelated quote offered as evidence ("They are asking for $1,290" for the declared value).
 *
 * Derived deterministically from the document's own vocabulary for each input (its name and description): the words that belong to
 * exactly one input in the tree. Words shared by several inputs ("value", "damage", "delivery") say nothing about which input a
 * sentence is about and are dropped. Acronyms the document defines in parentheses (POD) are kept.
 *
 * Limits, on purpose: this can only know the manual's wording. A claim that states the fact in other words ("delivery receipt" where
 * the manual says "proof of delivery") has no cue and is escalated for review: a false escalation, never a silent approval.
 * Fixed-label (enum) inputs get none: their value is a classification, checked against the closed set instead.
 */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'was', 'were', 'are', 'not', 'any', 'only', 'true', 'false', 'case', 'cases', 'needed',
  'number', 'amount', 'total', 'time', 'date', 'dates', 'days', 'day', 'hours', 'hour', 'percent', 'usd', 'pounds', 'calendar', 'event', 'kind',
  'none', 'available', 'noted', 'stated', 'there', 'than', 'then', 'into', 'its', 'has', 'have', 'been', 'which', 'when', 'what', 'more', 'less',
]);

const stem = (w: string): string => {
  for (const suf of ['ing', 'ed', 'es', 's']) if (w.endsWith(suf) && w.length - suf.length >= 5) return w.slice(0, -suf.length);
  return w;
};

function tokensOf(input: Pick<TreeInput, 'name' | 'description'>): Set<string> {
  const desc = input.description.replace(/\(needed only[^)]*\)/gi, ' ').replace(/\(0[^)]*\)|;\s*0 if[^.]*/gi, ' ');
  const acronyms = [...desc.matchAll(/\(([A-Z]{2,6})\)/g)].map((m) => m[1]!.toLowerCase());
  const words = `${input.name.replace(/_/g, ' ')} ${desc}`.toLowerCase().split(/[^a-z]+/);
  const out = new Set<string>(acronyms);
  for (const w of words) if (w.length >= 3 && !STOP.has(w)) out.add(stem(w));
  return out;
}

/**
 * `hints` are cue words a reviewer adds per input name (synonyms the document never uses: "delivery receipt", "scrap", "storm").
 * They are merged with the derived ones; this is the review step in "customer reviews extracted expertise".
 */
export function deriveEvidenceCues(inputs: readonly TreeInput[], hints: Readonly<Record<string, readonly string[]>> = {}): TreeInput[] {
  const toks = inputs.map(tokensOf);
  const df = new Map<string, number>();
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
  return inputs.map((inp, i) => {
    if (inp.enum !== undefined) return inp;
    const cues = [...new Set([...[...toks[i]!].filter((w) => df.get(w) === 1).slice(0, 10), ...(hints[inp.name] ?? []).map((h) => h.toLowerCase().trim()).filter((h) => h.length > 0)])];
    return cues.length > 0 ? { ...inp, evidenceCues: cues } : inp;
  });
}
