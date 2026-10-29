import type { BenchmarkRun, Capability, Compilation, Source } from '../platform/wire';
import { reviewStateOf, summarize, type ReviewState } from './review';

/**
 * An "XO" in Studio is an analysed document: a succeeded compilation, named after the document it came from.
 * Nothing here is a version, a publisher or a score: the platform's compilation records carry none of those.
 */
export interface XoItem {
  readonly id: string;
  readonly label: string;
  readonly sourceId: string;
  readonly at: string;
}

export function documentLabel(filename: string): string {
  const base = filename.replace(/\.[A-Za-z0-9]{1,6}$/, '').trim();
  return base === '' ? filename : base;
}

export function xoItems(compilations: readonly Compilation[], sources: readonly Source[]): XoItem[] {
  const names = new Map(sources.map((s) => [s.sourceId, documentLabel(s.originalFilename)]));
  return compilations
    .filter((c) => c.status === 'succeeded')
    .map((c) => ({
      id: c.compilationId,
      label: names.get(c.sourceId) ?? 'Analysed document',
      sourceId: c.sourceId,
      at: c.completedAt ?? c.createdAt,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** What an XO is currently being looked at as: an analysed document in this workspace, or a package in the registry. */
export type XoSubject = { readonly kind: 'analysis'; readonly id: string } | { readonly kind: 'package'; readonly id: string };

export function categoryLabel(category: string): string {
  const t = category.replace(/[_-]+/g, ' ').trim();
  return t === '' ? category : t.charAt(0).toUpperCase() + t.slice(1);
}

export interface CategoryScore {
  readonly category: string;
  readonly score: number;
  readonly runAt: string;
  readonly runs: number;
}

/** The latest recorded run in each category. Nothing is averaged or combined: a category with no run is simply absent. */
export function latestByCategory(runs: readonly BenchmarkRun[]): CategoryScore[] {
  const by = new Map<string, { latest: BenchmarkRun; n: number }>();
  for (const r of runs) {
    const cur = by.get(r.category);
    by.set(r.category, { latest: cur === undefined || r.runAt > cur.latest.runAt ? r : cur.latest, n: (cur?.n ?? 0) + 1 });
  }
  return [...by.entries()]
    .map(([category, v]) => ({ category, score: v.latest.score, runAt: v.latest.runAt, runs: v.n }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * The registry does not say what scale a score is on. A bar is drawn only when the number can be read as a fraction (0 to 1)
 * or a percentage (0 to 100); otherwise the bar is omitted and the number is shown on its own.
 */
export function barPercent(score: number): number | undefined {
  if (!Number.isFinite(score) || score < 0 || score > 100) return undefined;
  return score <= 1 ? score * 100 : score;
}

export interface NeedsInput {
  readonly name: string;
  readonly reason: string;
}

/** Rules XO could not turn into something it can carry out, with the reason the platform gave. Nothing is invented. */
export function needsInput(caps: readonly Capability[]): NeedsInput[] {
  return caps
    .filter((c) => c.status !== 'resolved')
    .map((c) => ({
      name: c.name,
      reason:
        c.reason !== undefined && c.reason !== ''
          ? c.reason
          : c.status === 'ambiguous'
            ? 'More than one reading is possible.'
            : c.status === 'denied'
              ? 'XO is not allowed to use this rule.'
              : 'XO could not work out what to do with this rule.',
    }));
}

export function ruleCounts(caps: readonly Capability[]) {
  return summarize(caps);
}

export type KnowledgeState = ReviewState | 'declared';
export interface KnowledgeItem {
  readonly id: string;
  readonly name: string;
  readonly state: KnowledgeState;
}
export interface KnowledgeNode {
  readonly id: string;
  readonly label: string;
  readonly state: KnowledgeState;
  readonly x: number;
  readonly y: number;
}
export interface KnowledgeGraph {
  readonly center: { readonly x: number; readonly y: number; readonly label: string };
  readonly nodes: readonly KnowledgeNode[];
  readonly hidden: number;
  readonly width: number;
  readonly height: number;
}

export const toKnowledgeItems = (caps: readonly Capability[]): KnowledgeItem[] =>
  caps.map((c) => ({ id: c.capabilityId, name: c.name, state: reviewStateOf(c) }));

/** The XO in the middle, its rules around it, each coloured by where it stands in review. At most `max` are drawn. */
export function knowledgeGraph(label: string, items: readonly KnowledgeItem[], max = 10, w = 420, h = 260): KnowledgeGraph {
  const shown = items.slice(0, max);
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2 - 36;
  const ry = h / 2 - 28;
  return {
    center: { x: cx, y: cy, label },
    nodes: shown.map((c, i) => {
      const a = (2 * Math.PI * i) / Math.max(shown.length, 1) - Math.PI / 2;
      return { id: c.id, label: c.name, state: c.state, x: Math.round(cx + rx * Math.cos(a)), y: Math.round(cy + ry * Math.sin(a)) };
    }),
    hidden: Math.max(0, items.length - shown.length),
    width: w,
    height: h,
  };
}

export function shortDid(did: string): string {
  return did.length <= 28 ? did : `${did.slice(0, 16)}…${did.slice(-8)}`;
}
