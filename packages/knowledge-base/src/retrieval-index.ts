/**
 * UW-4c (ADR 0034) — the retrieval index of a knowledge state: derived data, keyed by state id, persisted, rebuildable.
 *
 * States are immutable, so a state's index never changes: it is built once (on first search), written once next to the state
 * (`kb_indexes` in the SQL stores), and checked on every read — it must name the same tenant, the same state and the state's
 * content root, and hash to its stored digest. A rebuilt index is byte-for-byte the stored one (`buildKnowledgeIndex` is
 * deterministic), which is what "rebuild equivalence" means here: dropping every index loses nothing.
 *
 * The index holds every record of the state with its lifecycle and term frequencies, never record text. A query filters by
 * lifecycle (default: approved only), kind and type FIRST and scores BM25 over what is left, so a filtered search ranks exactly
 * as a search over only those records would. Hits are hydrated from the store and each record is checked against the state's
 * digest for it, as everywhere else.
 */
import { digestOf, type Digest } from './canonical.js';
import type { KnowledgeRecord, KnowledgeState, Lifecycle } from './types.js';
import { stateContentRoot } from './state-root.js';

export const KNOWLEDGE_INDEX_SCHEMA = 'xo.knowledge-index.v1';
/** The analyzer: NFKC, lower case, letters and digits, terms of two or more characters; BM25 with k1 = 1.2, b = 0.75. */
export const KNOWLEDGE_INDEX_ANALYZER = 'bm25-nfkc-v1';

export interface IndexedDoc {
  readonly id: string;
  readonly kind: KnowledgeRecord['kind'];
  readonly type: string;
  readonly lifecycle: Lifecycle;
  readonly length: number;
  /** Term → frequency, keys sorted. */
  readonly terms: Readonly<Record<string, number>>;
}

export interface KnowledgeIndex {
  readonly schema: typeof KNOWLEDGE_INDEX_SCHEMA;
  readonly analyzer: typeof KNOWLEDGE_INDEX_ANALYZER;
  readonly tenantId: string;
  readonly stateId: string;
  readonly contentRoot: string;
  /** Sorted by id. */
  readonly docs: readonly IndexedDoc[];
}

export interface IndexQuery {
  readonly text: string;
  readonly limit?: number;
  /** Which lifecycles to search. Default: only `active` (approved) knowledge. */
  readonly lifecycle?: readonly Lifecycle[] | 'any';
  readonly kind?: KnowledgeRecord['kind'];
  readonly type?: string;
}

export interface IndexHit {
  readonly id: string;
  readonly score: number;
}

const normalise = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export function indexTokens(s: string): string[] {
  return normalise(s)
    .split(' ')
    .filter((t) => t.length > 1);
}

/** The text a record is found by. */
export function indexText(r: KnowledgeRecord): string {
  if (r.kind === 'entity') return [r.canonicalName, ...r.aliases].join(' ');
  if (r.kind === 'claim') return r.text;
  return r.type;
}

/** Deterministic: the same state and records give the same index, whatever order they arrive in. */
export function buildKnowledgeIndex(state: KnowledgeState, records: ReadonlyMap<string, KnowledgeRecord>): KnowledgeIndex {
  const docs: IndexedDoc[] = [];
  for (const e of state.entries) {
    const r = records.get(e.id);
    if (r === undefined) throw new Error(`record ${e.id} of state ${state.stateId} is missing`);
    const toks = indexTokens(indexText(r));
    const freq = new Map<string, number>();
    for (const t of toks) freq.set(t, (freq.get(t) ?? 0) + 1);
    const terms: Record<string, number> = {};
    for (const t of [...freq.keys()].sort()) terms[t] = freq.get(t)!;
    docs.push({
      id: r.id,
      kind: r.kind,
      type: r.kind === 'claim' ? r.predicate : r.type,
      lifecycle: e.lifecycle,
      length: toks.length,
      terms,
    });
  }
  docs.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: KNOWLEDGE_INDEX_SCHEMA,
    analyzer: KNOWLEDGE_INDEX_ANALYZER,
    tenantId: state.tenantId,
    stateId: state.stateId,
    contentRoot: stateContentRoot(state),
    docs,
  };
}

export function indexDigest(index: KnowledgeIndex): Digest {
  return digestOf(index);
}

/** Why a stored index may not be used for this state, or undefined when it may. */
export function indexMismatch(index: KnowledgeIndex, state: KnowledgeState): string | undefined {
  if (index.schema !== KNOWLEDGE_INDEX_SCHEMA || index.analyzer !== KNOWLEDGE_INDEX_ANALYZER) return 'it was built by another analyzer';
  if (index.tenantId !== state.tenantId) return `it belongs to tenant "${index.tenantId}"`;
  if (index.stateId !== state.stateId) return `it indexes state ${index.stateId}`;
  if (index.contentRoot !== stateContentRoot(state)) return "its content root is not the state's";
  if (index.docs.length !== state.entries.length) return 'it does not cover every record of the state';
  return undefined;
}

/** BM25 over the documents the filters leave (statistics from those documents only). Ties break by record id. */
export function queryKnowledgeIndex(index: KnowledgeIndex, query: IndexQuery): readonly IndexHit[] {
  const lifecycles = query.lifecycle === 'any' ? undefined : new Set(query.lifecycle ?? ['active']);
  const docs = index.docs.filter(
    (d) =>
      (lifecycles === undefined || lifecycles.has(d.lifecycle)) &&
      (query.kind === undefined || d.kind === query.kind) &&
      (query.type === undefined || d.type === query.type),
  );
  const q = [...new Set(indexTokens(query.text))];
  if (q.length === 0 || docs.length === 0) return [];
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const t of q) df.set(t, docs.filter((d) => d.terms[t] !== undefined).length);
  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map((d) => {
      let score = 0;
      for (const t of q) {
        const f = d.terms[t] ?? 0;
        if (f === 0) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      return { id: d.id, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, c) => c.score - a.score || a.id.localeCompare(c.id))
    .slice(0, query.limit ?? 10)
    .map((x) => ({ id: x.id, score: Math.round(x.score * 1000) / 1000 }));
}
