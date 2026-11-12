import type { Citation, Evidence } from './types.js';

/**
 * Evidence handling: the code between "the knowledge system returned these" and "the model is shown these", and
 * between "the model wrote [E2]" and "the user sees footnote 1". Everything here is deterministic and tested, because
 * it is what makes a citation mean something: a marker the model invents resolves to nothing and is removed.
 */

export interface EvidenceLimits {
  readonly maxItems: number;
  readonly maxExcerptChars: number;
  readonly maxTotalChars: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = { maxItems: 12, maxExcerptChars: 1500, maxTotalChars: 12_000 };

export interface PreparedEvidence {
  /** Short stable handle shown to the model ("E1"); the real id never has to survive a model's transcription. */
  readonly alias: string;
  readonly evidence: Evidence;
}

/** Escapes text so evidence can never close its own tag or open a forged one. */
export function escapeForPrompt(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const escapeAttr = (text: string): string =>
  escapeForPrompt(text)
    .replace(/"/g, '&quot;')
    .replace(/[\r\n]+/g, ' ');

/** Dedupes by id, drops empty excerpts, orders by relevance (stable for ties), and applies count and size limits. */
export function prepareEvidence(raw: readonly Evidence[], limits: EvidenceLimits = DEFAULT_EVIDENCE_LIMITS): PreparedEvidence[] {
  const seen = new Set<string>();
  const unique: { evidence: Evidence; order: number }[] = [];
  raw.forEach((e, order) => {
    if (seen.has(e.id) || e.excerpt.trim().length === 0) return;
    seen.add(e.id);
    unique.push({ evidence: e, order });
  });
  unique.sort((a, b) => (b.evidence.score ?? 0) - (a.evidence.score ?? 0) || a.order - b.order);

  const out: PreparedEvidence[] = [];
  let total = 0;
  for (const { evidence } of unique) {
    if (out.length >= limits.maxItems) break;
    const excerpt = evidence.excerpt.trim().slice(0, limits.maxExcerptChars);
    if (total + excerpt.length > limits.maxTotalChars && out.length > 0) break;
    total += excerpt.length;
    out.push({ alias: `E${out.length + 1}`, evidence: { ...evidence, excerpt } });
  }
  return out;
}

export function renderEvidence(prepared: readonly PreparedEvidence[]): string {
  return prepared
    .map(({ alias, evidence: e }) => {
      const attrs = [`id="${alias}"`, `source="${escapeAttr(e.sourceName)}"`];
      if (e.sourceType !== undefined) attrs.push(`type="${escapeAttr(e.sourceType)}"`);
      if (e.asOf !== undefined) attrs.push(`as_of="${escapeAttr(e.asOf)}"`);
      return `<xo-evidence ${attrs.join(' ')}>\n${escapeForPrompt(e.excerpt)}\n</xo-evidence>`;
    })
    .join('\n');
}

const MARKER = /\[\s*(E\d+(?:\s*[,;]\s*E\d+)*)\s*\]/gi;
const CITATION_EXCERPT_CHARS = 300;

/**
 * Turns the model's evidence handles into the numbered citations the user sees. Numbers are assigned in order of first
 * valid use, so footnote 1 is always the first thing cited. A handle that was never retrieved is dropped and counted —
 * the model cannot cite what it was not shown.
 */
export class CitationRegistry {
  private readonly byAlias = new Map<string, PreparedEvidence>();
  private readonly indexByAlias = new Map<string, number>();
  private readonly ordered: Citation[] = [];
  private droppedCount = 0;

  constructor(prepared: readonly PreparedEvidence[]) {
    for (const p of prepared) this.byAlias.set(p.alias, p);
  }

  private cite(rawAlias: string): number | undefined {
    const alias = rawAlias
      .trim()
      .toUpperCase()
      .replace(/^(\d+)$/, 'E$1');
    const found = this.byAlias.get(alias);
    if (found === undefined) {
      this.droppedCount += 1;
      return undefined;
    }
    const existing = this.indexByAlias.get(alias);
    if (existing !== undefined) return existing;
    const e = found.evidence;
    const index = this.ordered.length + 1;
    this.indexByAlias.set(alias, index);
    this.ordered.push({
      index,
      evidenceId: e.id,
      sourceId: e.sourceId,
      sourceName: e.sourceName,
      ...(e.sourceType !== undefined ? { sourceType: e.sourceType } : {}),
      ...(e.uri !== undefined ? { uri: e.uri } : {}),
      ...(e.asOf !== undefined ? { asOf: e.asOf } : {}),
      excerpt: e.excerpt.slice(0, CITATION_EXCERPT_CHARS),
    });
    return index;
  }

  /** Structured fields: ["E1","E3"] -> [1,2]; unknown handles dropped. */
  refs(aliases: readonly string[]): number[] {
    const out: number[] = [];
    for (const a of aliases) {
      const i = this.cite(a);
      if (i !== undefined && !out.includes(i)) out.push(i);
    }
    return out;
  }

  /** Prose: rewrites "[E3, E1]" as "[1, 2]" and removes markers that resolve to nothing. */
  rewrite(text: string): string {
    const rewritten = text.replace(MARKER, (_m, group: string) => {
      const indexes = this.refs(group.split(/[,;]/));
      return indexes.length > 0 ? `[${indexes.join(', ')}]` : '';
    });
    return rewritten
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .trim();
  }

  citations(): readonly Citation[] {
    return this.ordered;
  }

  /** Markers/ids the model produced that matched nothing it was shown. */
  dropped(): number {
    return this.droppedCount;
  }
}

/** Assistant text goes back into later prompts as history; the footnote numbers belong to a turn the model no longer sees. */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\s?\[\d+(?:,\s*\d+)*\]/g, '');
}
