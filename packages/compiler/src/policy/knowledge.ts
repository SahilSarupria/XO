import type { PolicyEntry } from './segment.js';

export interface PolicyKnowledgeNode {
  readonly id: string;
  readonly kind: 'rule' | 'background';
  readonly pinned?: true;
  readonly properties: { readonly title: string; readonly section: string; readonly text: string; readonly keywords?: string };
  readonly confidence: number;
  readonly provenance: { readonly source: string; readonly origin: 'policy-synthesis'; readonly entry: number };
}

export interface PolicyKnowledgeEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'applies_with' | 'precedes';
}

export interface PolicyKnowledge {
  readonly nodes: PolicyKnowledgeNode[];
  readonly edges: PolicyKnowledgeEdge[];
}

const STOP = new Set(
  'a an the and or of to in on at for by with from as is are was were be been it its this that these those not no if then else than into over under per any all each must may shall should can will do does did has have had who whom which what when where why how also such other only'.split(
    ' ',
  ),
);

/** Lower-cased content words with a light stem, for similarity (not for display). */
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9$]+/g) ?? []) {
    if (STOP.has(raw) || raw.length < 2) continue;
    let w = raw;
    if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 3 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

/** A passage that obliges, forbids, permits conditionally, or decides something — as opposed to explaining or describing. */
const STRONG_NORMATIVE =
  /\b(must|shall|never|may not|required|only (?:payable|when|if|for)|is denied|are denied|denied|escalat\w+|approv\w+|is paid|are paid|paid at|payable|compensable|deduct\w+|subtract\w+|extended to|excluded|regardless|do not|not (?:allowed|permitted|payable|compensable))\b/i;

/** Wording that marks a rule as applying to *every* case or as taking precedence over other rules (cannot be found by similarity to a case that does not mention it). */
const GATE_MARKERS: readonly RegExp[] = [
  /\bregardless of\b/i,
  /\bbefore applying any other rule\b/i,
  /\bstop at the first rule\b/i,
  /\bin this order\b/i,
  /\bearlier rule always wins\b/i,
  /\bapplies? to every\b/i,
  /\bunder no circumstances\b/i,
  /\bwithout exception\b/i,
  /\bin all cases\b/i,
  /\bnever (?:pays?|denies|approves?|decides?)\b/i,
];
const MAX_PINNED = 4;

/** "proof of delivery (POD)" -> { abbr: "POD", phrase: "proof of delivery" }: trailing words whose initials spell the abbreviation. */
function abbreviationPairs(entries: readonly PolicyEntry[]): { abbr: string; phrase: string }[] {
  const pairs = new Map<string, string>();
  const re = /((?:[A-Za-z][A-Za-z-]*\s+){1,5}[A-Za-z][A-Za-z-]*)\s+\(([A-Z]{2,8})s?\)/g;
  const initials = (words: readonly string[], skipShort: boolean): string =>
    words
      .filter((w) => !skipShort || w.length > 2)
      .map((w) => (w[0] ?? '').toUpperCase())
      .join('');
  for (const e of entries)
    for (let m = re.exec(e.text); m !== null; m = re.exec(e.text)) {
      const abbr = m[2] as string;
      const words = (m[1] as string).trim().split(/\s+/);
      for (let take = 1; take <= words.length; take++) {
        const cand = words.slice(-take);
        if (initials(cand, false) === abbr || initials(cand, true) === abbr) {
          pairs.set(abbr, cand.join(' ').toLowerCase());
          break;
        }
      }
    }
  return [...pairs].map(([abbr, phrase]) => ({ abbr, phrase }));
}

function definedTerms(entry: PolicyEntry): string[] {
  const terms: string[] = [];
  const re = /\b(?:the|a|an)\s+([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3}?)\s+(?:is|are)\s+(?:the|a|an|equal to|defined as|calculated as)\b/gi;
  for (const s of entry.sentences)
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      const t = (m[1] as string).toLowerCase();
      if (contentTokens(t).length >= 2) terms.push(t);
    }
  return terms;
}

function bigrams(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < tokens.length; i++) out.add(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

export function buildPolicyKnowledge(entries: readonly PolicyEntry[], source: string): PolicyKnowledge {
  const abbr = abbreviationPairs(entries);

  const gateScore = (e: PolicyEntry): number => GATE_MARKERS.filter((r) => r.test(e.text)).length;
  const pinnedIds = new Set(
    entries
      .filter((e) => gateScore(e) > 0)
      .sort((a, b) => gateScore(b) - gateScore(a) || a.index - b.index)
      .slice(0, MAX_PINNED)
      .map((e) => e.id),
  );

  const nodes: PolicyKnowledgeNode[] = entries.map((e) => {
    const lower = `${e.title} ${e.text}`.toLowerCase();
    const kw = new Set<string>();
    for (const p of abbr) {
      if (lower.includes(p.phrase) || new RegExp(`\\b${p.abbr}\\b`).test(`${e.title} ${e.text}`)) {
        kw.add(p.abbr);
        kw.add(p.phrase);
      }
    }
    const tag = /\(([A-Z]{1,3}\d{1,3})\)/.exec(e.section);
    if (tag !== null) kw.add(tag[1] as string);
    const normative = STRONG_NORMATIVE.test(e.text);
    return {
      id: e.id,
      kind: normative ? 'rule' : 'background',
      ...(pinnedIds.has(e.id) ? { pinned: true as const } : {}),
      properties: {
        title: e.title,
        section: e.section,
        text: e.text,
        ...(kw.size > 0 ? { keywords: [...kw].join(' ') } : {}),
      },
      confidence: normative ? 0.8 : 0.6,
      provenance: { source, origin: 'policy-synthesis', entry: e.index },
    };
  });

  // --- edges ---------------------------------------------------------------------------------------------------
  const edges: PolicyKnowledgeEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: PolicyKnowledgeEdge['kind']): void => {
    if (from === to) return;
    const key = kind === 'applies_with' ? `${kind}:${[from, to].sort().join('|')}` : `${kind}:${from}|${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };

  // precedence: an ordered list "(1) a, (2) b, (3) c" inside an entry names other entries, in order
  for (const e of entries) {
    const items = [...e.text.matchAll(/\((\d{1,2})\)\s+([^,;()]+?)(?=,?\s*(?:\(\d{1,2}\)|\.|;|$))/g)].map((m) => m[2] as string);
    if (items.length < 3) continue;
    const matched = items.map((item) => {
      const it = new Set(contentTokens(item));
      let best: { id: string; score: number } | undefined;
      for (const o of entries) {
        if (o.id === e.id) continue;
        const tt = new Set(contentTokens(`${o.title} ${o.section}`));
        const inter = [...it].filter((t) => tt.has(t)).length;
        const score = inter / (it.size || 1);
        if (inter > 0 && score >= 0.5 && (best === undefined || score > best.score)) best = { id: o.id, score };
      }
      return best?.id;
    });
    const ids = matched.filter((x): x is string => x !== undefined);
    for (let i = 0; i + 1 < ids.length; i++) add(ids[i] as string, ids[i + 1] as string, 'precedes');
  }

  // co-application: (a) a term one entry defines is used by another; (b) entries share rare two-word phrases
  const tokens = entries.map((e) => contentTokens(e.text));
  const bi = tokens.map((t) => bigrams(t));
  const df = new Map<string, number>();
  for (const b of bi) for (const g of b) df.set(g, (df.get(g) ?? 0) + 1);
  const scoreByPair = new Map<string, number>();
  const bump = (a: number, b: number, w: number): void => {
    const key = `${Math.min(a, b)}|${Math.max(a, b)}`;
    scoreByPair.set(key, (scoreByPair.get(key) ?? 0) + w);
  };
  entries.forEach((a, i) => {
    for (const term of definedTerms(a)) {
      entries.forEach((b, j) => {
        if (i !== j && b.text.toLowerCase().includes(term)) bump(i, j, 2);
      });
    }
  });
  for (let i = 0; i < entries.length; i++)
    for (let j = i + 1; j < entries.length; j++) {
      let shared = 0;
      for (const g of bi[i] as Set<string>) if ((bi[j] as Set<string>).has(g) && (df.get(g) ?? 0) <= 3) shared++;
      if (shared > 0) bump(i, j, shared);
    }
  const perNode = new Map<number, number>();
  const ranked = [...scoreByPair].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  for (const [key, w] of ranked) {
    if (w < 2) continue;
    const [i, j] = key.split('|').map(Number) as [number, number];
    if ((perNode.get(i) ?? 0) >= 3 || (perNode.get(j) ?? 0) >= 3) continue;
    perNode.set(i, (perNode.get(i) ?? 0) + 1);
    perNode.set(j, (perNode.get(j) ?? 0) + 1);
    add((entries[i] as PolicyEntry).id, (entries[j] as PolicyEntry).id, 'applies_with');
  }
  return { nodes, edges };
}
