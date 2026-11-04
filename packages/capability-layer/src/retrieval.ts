/**
 * Dependency-free BM25 over a package's knowledge-graph nodes. Works on both
 * hand-authored graphs and compiler output: node text is every string found
 * anywhere in `properties` (or the node itself), so it does not depend on
 * either side's exact schema.
 */

export interface GraphNode {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly score: number;
  readonly pinned: boolean;
}

interface Doc {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly pinned: boolean;
  readonly tf: Map<string, number>;
  readonly len: number;
}

const STOP = new Set(
  'a an the and or of to in on at for by with from as is are was were be been it its this that these those not no if then else than into over under per any all each must may shall should can will do does did has have had who whom which what when where why how'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9$.%]+/g) ?? []) {
    let w = raw.replace(/^[.$]+|[.]+$/g, '');
    if (w.length === 0 || STOP.has(w)) continue;
    // light stemming — enough to match "pallets"/"pallet", "damaged"/"damage", "filing"/"filed"
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 3 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
    if (w.length > 1) out.push(w);
  }
  return out;
}

/** Concatenates every string reachable in `value` (depth-limited), space separated. */
export function collectText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > 6 || value === null || typeof value !== 'object') return '';
  if (Array.isArray(value)) return value.map((v) => collectText(v, depth + 1)).join(' ');
  return Object.values(value as Record<string, unknown>)
    .map((v) => collectText(v, depth + 1))
    .join(' ');
}

/** What a retrieved node shows the model: title + body when the node has them, otherwise every string it carries. Index-only fields (e.g. author keywords) are not displayed. */
export function nodeDisplayText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return collectText(node).trim();
  const n = node as { properties?: unknown; title?: unknown; text?: unknown };
  const p = (typeof n.properties === 'object' && n.properties !== null ? n.properties : undefined) as
    { title?: unknown; text?: unknown } | undefined;
  const text = typeof p?.text === 'string' ? p.text : typeof n.text === 'string' ? n.text : undefined;
  if (text === undefined) {
    // Compiler-produced nodes keep prose in summary/description/definition (the latter is often a truncated lead-in).
    // Show the most informative of those instead of dumping every field, which would include confidence/status noise.
    const bag = (n.properties ?? node) as Record<string, unknown>;
    const prose = ['summary', 'description', 'definition', 'statement', 'content']
      .map((k) => bag[k])
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .sort((a, b) => b.length - a.length);
    if (prose.length > 0) {
      const name = typeof bag['name'] === 'string' ? bag['name'] : undefined;
      const body = (prose[0] as string).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
      return (name !== undefined && !body.startsWith(name) ? `${name}: ${body}` : body).trim();
    }
    return collectText(n.properties ?? node).trim();
  }
  const title = typeof p?.title === 'string' ? p.title : typeof n.title === 'string' ? n.title : undefined;
  return (title !== undefined ? `${title}: ${text}` : text).trim();
}

/** Edge kinds along which a retrieved node pulls its neighbours in (they are applied together). */
/**
 * Author-declared node kinds are a ranking prior: a rule that governs the
 * decision should beat a glossary entry that merely shares vocabulary with the
 * case. Unknown kinds are neutral.
 */
const KIND_PRIOR: Readonly<Record<string, number>> = {
  rule: 2,
  procedure: 2,
  heuristic: 1.5,
  constraint: 1.5,
  background: 0.7,
  glossary: 0.7,
};

const EXPAND_KINDS = new Set(['applies_with', 'requires', 'refines']);

export interface SearchOptions {
  /** Retrieve per sentence and fuse the rankings (reciprocal rank fusion). Default true. */
  readonly multiQuery?: boolean;
  /** Add one-hop neighbours of each hit along `applies_with`/`requires`/`refines` edges. Default true. */
  readonly expand?: boolean;
}

export class KnowledgeIndex {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private avgLen = 0;
  private readonly neighbours = new Map<string, string[]>();

  constructor(nodes: readonly unknown[], edges: readonly unknown[] = []) {
    for (const e of edges) {
      if (typeof e !== 'object' || e === null) continue;
      const ed = e as { from?: unknown; to?: unknown; kind?: unknown; type?: unknown };
      const kind = typeof ed.kind === 'string' ? ed.kind : typeof ed.type === 'string' ? ed.type : '';
      if (typeof ed.from !== 'string' || typeof ed.to !== 'string' || !EXPAND_KINDS.has(kind)) continue;
      (this.neighbours.get(ed.from) ?? this.neighbours.set(ed.from, []).get(ed.from)!).push(ed.to);
      if (kind === 'applies_with') (this.neighbours.get(ed.to) ?? this.neighbours.set(ed.to, []).get(ed.to)!).push(ed.from);
    }
    for (const n of nodes) {
      if (typeof n !== 'object' || n === null) continue;
      const node = n as { id?: unknown; kind?: unknown; properties?: unknown; pinned?: unknown; text?: unknown; title?: unknown };
      const id = typeof node.id === 'string' ? node.id : `node_${this.docs.length}`;
      const body = node.properties !== undefined ? collectText(node.properties) : collectText(node);
      const text = nodeDisplayText(n);
      if (body.trim().length === 0 || text.length === 0) continue;
      const tf = new Map<string, number>();
      const toks = tokenize(body);
      // the title/name is the cheapest strong signal; weight it by repeating it
      const title =
        typeof node.title === 'string'
          ? node.title
          : typeof (node.properties as { title?: unknown } | undefined)?.title === 'string'
            ? (node.properties as { title: string }).title
            : '';
      const kwRaw = (node.properties as { keywords?: unknown } | undefined)?.keywords;
      const kw = typeof kwRaw === 'string' ? tokenize(kwRaw) : [];
      // title and author-supplied keywords are the cheapest strong signals; weight them by repeating
      for (const t of [...toks, ...tokenize(title), ...tokenize(title), ...kw, ...kw]) tf.set(t, (tf.get(t) ?? 0) + 1);
      this.docs.push({
        id,
        kind: typeof node.kind === 'string' ? node.kind : 'node',
        text,
        pinned: node.pinned === true,
        tf,
        len: toks.length,
      });
    }
    for (const d of this.docs) for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.docs.length === 0 ? 0 : this.docs.reduce((s, d) => s + d.len, 0) / this.docs.length;
  }

  get size(): number {
    return this.docs.length;
  }

  private rank(query: string): { d: Doc; score: number }[] {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const k1 = 1.4;
    const b = 0.75;
    const scored = this.docs.map((d) => {
      let score = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (f === undefined) continue;
        const n = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / (this.avgLen || 1)));
      }
      return { d, score };
    });
    return scored.filter((s) => s.score > 0).sort((a, b2) => b2.score - a.score || a.d.id.localeCompare(b2.d.id));
  }

  /**
   * Pinned nodes always come first (the package author's "applies to every case"
   * set — gates like hazmat or approval limits can never be found by similarity
   * to a case that does not mention them). The rest is BM25 over the whole query
   * fused with BM25 over each sentence, then expanded one hop along graph edges.
   */
  search(query: string, k: number, opts: SearchOptions = {}): GraphNode[] {
    const pinnedDocs = this.docs.filter((d) => d.pinned);
    const toNode = (d: Doc, score: number, pinned: boolean): GraphNode => ({ id: d.id, kind: d.kind, text: d.text, score, pinned });
    const pinned = pinnedDocs.map((d) => toNode(d, 0, true));
    const capacity = Math.max(0, k - pinned.length);

    const fused = new Map<string, number>();
    const addList = (list: { d: Doc; score: number }[], depth: number): void => {
      list.slice(0, depth).forEach((r, i) => fused.set(r.d.id, (fused.get(r.d.id) ?? 0) + 1 / (60 + i)));
    };
    addList(this.rank(query), 8);
    if (opts.multiQuery !== false) {
      // Each sentence votes only for its few best matches: a node that is merely *generically* similar to many
      // sentences must not outrank a node that is the clear best match for one of them.
      const sentences = query.split(/(?<=[.!?])\s+/).filter((s) => tokenize(s).length >= 3);
      if (sentences.length > 1) for (const s of sentences) addList(this.rank(s), 3);
    }
    const byId = new Map(this.docs.map((d) => [d.id, d] as const));
    const seeds = [...fused.entries()]
      .filter(([id]) => byId.get(id)?.pinned !== true)
      .map(([id, sc]) => [id, sc * (KIND_PRIOR[byId.get(id)?.kind ?? ''] ?? 1)] as [string, number])
      .sort((a, b2) => b2[1] - a[1] || a[0].localeCompare(b2[0]));

    const chosen: GraphNode[] = [];
    const have = new Set<string>();
    const push = (id: string, score: number): void => {
      const d = byId.get(id);
      if (d === undefined || d.pinned || have.has(id) || chosen.length >= capacity) return;
      have.add(id);
      chosen.push(toNode(d, score, false));
    };
    for (const [id, score] of seeds) {
      push(id, score);
      if (opts.expand !== false) for (const nb of this.neighbours.get(id) ?? []) push(nb, score * 0.5);
      if (chosen.length >= capacity) break;
    }
    return [...pinned, ...chosen];
  }
}
