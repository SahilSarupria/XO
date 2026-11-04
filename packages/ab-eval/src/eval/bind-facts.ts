import type { TreeInput } from '@xo/capability-layer';

/**
 * Reads a case's facts the way a model (or an operator's field mapping) would when handed a compiled tree's inputs:
 * for each input the tree declares, find the case vocabulary entry it describes and take that value. Matching is by
 * the words of the input's name and description only — no knowledge of any domain — and the outcome is reported so a
 * reader can see what was bound to what.
 *
 * This exists because the compiler names inputs from the document's own words, so a compiled tree and an oracle's
 * fact record do not share field names. It is a PROXY for the live arms (where a real model reads the tool schema);
 * a wrong binding here lowers the measured agreement rather than hiding the error.
 */

export interface Binding {
  readonly input: string;
  /** vocabulary entry the input was bound to, with the enum value for a boolean-from-enum binding */
  readonly source?: string;
  readonly score: number;
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'for',
  'to',
  'by',
  'is',
  'was',
  'were',
  'are',
  'be',
  'true',
  'false',
  'if',
  'and',
  'or',
  'with',
  'that',
  'this',
  'number',
  'case',
  'cases',
  'kind',
  'from',
  'than',
  'only',
  'needed',
  'its',
  'it',
  'has',
  'have',
  'whether',
  'who',
  'time',
  'noted',
]);
const stem = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const UNITS: Readonly<Record<string, string>> = { pounds: 'lb', pound: 'lb', dollars: 'usd', percent: 'pct', percentage: 'pct' };

export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')) {
    if (raw === '' || STOP.has(raw)) continue;
    out.add(stem(UNITS[raw] ?? raw));
  }
  return out;
}

const overlap = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / Math.min(a.size, b.size);
};

export function bindFacts(
  compiled: readonly TreeInput[],
  vocabulary: readonly TreeInput[],
  facts: Readonly<Record<string, unknown>>,
  threshold = 0.6,
): { facts: Record<string, unknown>; binding: Binding[] } {
  const out: Record<string, unknown> = {};
  const binding: Binding[] = [];
  for (const c of compiled) {
    const cTok = new Set([...tokens(c.name), ...tokens(c.description)]);
    const cName = tokens(c.name);
    let best: { g: TreeInput; value?: string; score: number } | undefined;
    for (const g of vocabulary) {
      const compatible =
        c.type === g.type || (c.type === 'boolean' && g.enum !== undefined) || (c.type === 'string' && g.type === 'string');
      if (!compatible) continue;
      if (c.type === 'boolean' && g.type === 'string' && g.enum !== undefined) {
        for (const v of g.enum) {
          const vt = tokens(v);
          if (vt.size >= 2 && [...vt].every((t) => cTok.has(t)) && (best === undefined || 1 > best.score)) best = { g, value: v, score: 1 };
        }
        continue;
      }
      const gTok = new Set([...tokens(g.name), ...tokens(g.description)]);
      // names count most: a shared name token is worth more than a shared description word
      const score = Math.max(overlap(tokens(g.name), cName), 0.8 * overlap(gTok, cTok));
      if (score >= threshold && (best === undefined || score > best.score)) best = { g, score };
    }
    if (best === undefined) {
      binding.push({ input: c.name, score: 0 });
      continue;
    }
    const raw = facts[best.g.name];
    binding.push({
      input: c.name,
      source: best.value !== undefined ? `${best.g.name}==${best.value}` : best.g.name,
      score: Math.round(best.score * 100) / 100,
    });
    if (raw === undefined || raw === null) continue;
    if (best.value !== undefined) out[c.name] = raw === best.value;
    else if (c.type === 'string' && c.enum !== undefined)
      out[c.name] = c.enum.find((e) => e.toLowerCase() === String(raw).toLowerCase()) ?? raw;
    else out[c.name] = raw;
  }
  return { facts: out, binding };
}
