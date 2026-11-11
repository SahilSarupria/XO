/**
 * Hybrid retrieval over Domain Knowledge Packs. Engines share one interface; vectors are just another engine.
 *
 *  - StructuredLookupRetriever: exact term/synonym phrase lookup (whole words, case-insensitive, simple plural tolerance).
 *  - Bm25Retriever: lexical ranking over concept text (label, synonyms, definition) for descriptive queries.
 *  - HybridRetriever: fuses any set of engines with Reciprocal Rank Fusion and preserves, per item, which engine(s) produced
 *    it and at what rank — retrieval is evidence for an interpretation and must stay explainable.
 *
 * No engine decides what a document contains. A real embedding engine (vector search) implements `KnowledgeRetriever` and is
 * injected; none is bundled, because it should only be adopted if it measurably beats structured + BM25 retrieval.
 */
import type { DomainKnowledgePack } from './types.js';

export type RetrievalEngine = 'structured' | 'bm25' | 'vector' | (string & {});

export interface RetrievalProvenance {
  readonly engine: RetrievalEngine;
  readonly rank: number;
  readonly rawScore: number;
}

export interface RetrievedConcept {
  readonly packId: string;
  readonly conceptId: string;
  readonly label: string;
  readonly definition: string;
  readonly score: number;
  readonly provenance: readonly RetrievalProvenance[];
}

export interface KnowledgeRetriever {
  retrieve(query: string, k: number): readonly RetrievedConcept[];
}

const STOPWORDS = new Set('the a an of to is are be by for in on or and if with that this any each than at as it its from not may must shall will how what which who whom into over under their there'.split(' '));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !STOPWORDS.has(t));
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-phrase matcher: boundaries on both sides, the last word may carry a plural "s"/"es". */
export function phraseRegex(phrase: string, flags = 'giu'): RegExp {
  const words = phrase.trim().split(/\s+/).map(escapeRegex);
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?:s|es)?(?![\\p{L}\\p{N}])`, flags);
}

export class StructuredLookupRetriever implements KnowledgeRetriever {
  constructor(private readonly packs: readonly DomainKnowledgePack[]) {}

  retrieve(query: string, k: number): readonly RetrievedConcept[] {
    const hits: { item: Omit<RetrievedConcept, 'provenance' | 'score'>; score: number }[] = [];
    for (const pack of this.packs) {
      for (const concept of pack.concepts) {
        const viaLabel = phraseRegex(concept.label).test(query);
        const viaSynonym = !viaLabel && concept.synonyms.some((s) => phraseRegex(s).test(query));
        if (!viaLabel && !viaSynonym) continue;
        hits.push({ item: { packId: pack.id, conceptId: concept.id, label: concept.label, definition: concept.definition }, score: concept.weight * (viaLabel ? 1 : 0.9) });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.item.conceptId.localeCompare(b.item.conceptId));
    return hits.slice(0, k).map((h, i) => ({ ...h.item, score: h.score, provenance: [{ engine: 'structured', rank: i + 1, rawScore: h.score }] }));
  }
}

interface Bm25Doc {
  readonly packId: string;
  readonly conceptId: string;
  readonly label: string;
  readonly definition: string;
  readonly tokens: readonly string[];
}

export class Bm25Retriever implements KnowledgeRetriever {
  private readonly docs: Bm25Doc[] = [];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLen: number;

  constructor(packs: readonly DomainKnowledgePack[], private readonly k1 = 1.2, private readonly b = 0.75) {
    for (const pack of packs) {
      for (const concept of pack.concepts) {
        const tokens = tokenize([concept.label, concept.label, ...concept.synonyms, concept.definition].join(' '));
        this.docs.push({ packId: pack.id, conceptId: concept.id, label: concept.label, definition: concept.definition, tokens });
        for (const t of new Set(tokens)) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      }
    }
    this.avgLen = this.docs.length === 0 ? 0 : this.docs.reduce((a, d) => a + d.tokens.length, 0) / this.docs.length;
  }

  retrieve(query: string, k: number): readonly RetrievedConcept[] {
    const q = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const scored: { doc: Bm25Doc; score: number }[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of q) {
        const tf = doc.tokens.filter((t) => t === term).length;
        if (tf === 0) continue;
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * (tf * (this.k1 + 1))) / (tf + this.k1 * (1 - this.b + (this.b * doc.tokens.length) / (this.avgLen || 1)));
      }
      if (score > 0) scored.push({ doc, score });
    }
    scored.sort((a, b) => b.score - a.score || a.doc.conceptId.localeCompare(b.doc.conceptId));
    return scored.slice(0, k).map((s, i) => ({
      packId: s.doc.packId,
      conceptId: s.doc.conceptId,
      label: s.doc.label,
      definition: s.doc.definition,
      score: s.score,
      provenance: [{ engine: 'bm25', rank: i + 1, rawScore: s.score }],
    }));
  }
}

/** Reciprocal Rank Fusion: rank-based, so engines with incomparable score scales (BM25 vs cosine vs weights) combine fairly. */
export class HybridRetriever implements KnowledgeRetriever {
  constructor(private readonly engines: readonly KnowledgeRetriever[], private readonly rrfK = 60) {}

  retrieve(query: string, k: number): readonly RetrievedConcept[] {
    const merged = new Map<string, { base: RetrievedConcept; score: number; provenance: RetrievalProvenance[] }>();
    for (const engine of this.engines) {
      for (const [i, item] of engine.retrieve(query, Math.max(k * 3, 10)).entries()) {
        const key = `${item.packId}\u0000${item.conceptId}`;
        const entry = merged.get(key) ?? { base: item, score: 0, provenance: [] };
        entry.score += 1 / (this.rrfK + i + 1);
        entry.provenance.push(...item.provenance);
        merged.set(key, entry);
      }
    }
    return [...merged.values()]
      .sort((a, b) => b.score - a.score || a.base.conceptId.localeCompare(b.base.conceptId))
      .slice(0, k)
      .map((e) => ({ ...e.base, score: e.score, provenance: e.provenance }));
  }
}
