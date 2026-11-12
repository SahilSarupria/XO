/**
 * Cross-document reasoning: conflicts between rules, and supersession/amendment wording.
 *
 * Principles:
 *  - A conflict is SURFACED, never silently resolved. It is resolved only by an explicit, caller-supplied precedence order
 *    (an authority ranking), and the resolution names both the winner and the loser. No recency or length guessing.
 *  - A conflict needs two rules with structured conditions and DIFFERENT typed outcomes (approve / deny / requires_approval /
 *    escalate). Identical canonical conditions are a definite conflict; overlapping numeric ranges on the same field (and unit)
 *    are a potential one. Different fields never conflict.
 *  - Amendment wording ("supersedes clause 4.2", "as amended", "notwithstanding ...") is detected with its cue and, when
 *    unambiguous, an effective date. Dates written as dd/mm vs mm/dd are never guessed.
 * Pure and deterministic; language-level cues only (no subject-matter vocabulary).
 */
import type { XoirGraph } from '@xo/xoir';
import { nodesOfKind } from '@xo/xoir';
import { splitSentences } from '../capabilities/sentence-split.js';

export interface CrossDocumentSource {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly text: string;
}

/** Authority ranking, highest first. Entries are source paths (or source ids). */
export interface PrecedencePolicy {
  readonly order: readonly string[];
}

export interface ConflictSide {
  readonly nodeId: string;
  readonly sourcePath: string;
  readonly label: string;
  readonly outcomeType: string;
}

export type ConflictResolution =
  { readonly status: 'unresolved' } | { readonly status: 'resolved-by-precedence'; readonly winner: string; readonly loser: string };

export interface ConflictItem {
  readonly kind: 'identical-condition' | 'overlapping-range';
  readonly scope: 'cross-source' | 'within-source';
  readonly field?: string;
  readonly a: ConflictSide;
  readonly b: ConflictSide;
  readonly resolution: ConflictResolution;
}

export interface AmendmentItem {
  readonly sourcePath: string;
  readonly sentence: string;
  readonly cue: string;
  /** ISO date, only when the sentence states an unambiguous effective date. */
  readonly effectiveDate?: string;
}

export interface CrossDocumentAnalysis {
  readonly conflicts: readonly ConflictItem[];
  readonly amendments: readonly AmendmentItem[];
}

const DECISION_OUTCOMES = new Set(['approve', 'deny', 'requires_approval', 'escalate']);

// ── effective dates ──────────────────────────────────────────────────────────────────────────────────────────────────
const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function isoDate(y: number, m: number, d: number): string | undefined {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Parses the date following "effective [from|on|as of]" / "with effect from"; `undefined` when absent or ambiguous. */
export function parseEffectiveDate(text: string): string | undefined {
  const anchored = /(?:effective|with\s+effect)(?:\s+(?:from|on|as\s+of|date))?\s+(.+)$/i.exec(text);
  if (!anchored) return undefined;
  const rest = (anchored[1] ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(rest);
  if (m) return isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})\b/.exec(rest);
  if (m && MONTHS[(m[2] ?? '').toLowerCase()] !== undefined)
    return isoDate(Number(m[3]), MONTHS[(m[2] ?? '').toLowerCase()]!, Number(m[1]));
  m = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(rest);
  if (m && MONTHS[(m[1] ?? '').toLowerCase()] !== undefined)
    return isoDate(Number(m[3]), MONTHS[(m[1] ?? '').toLowerCase()]!, Number(m[2]));
  return undefined;
}

// ── amendments ───────────────────────────────────────────────────────────────────────────────────────────────────────
const STRUCTURE_WORD =
  /\b(?:clause|section|article|schedule|agreement|policy|addendum|appendix|version|provision|paragraph|terms|prior|previous|earlier|contract)\b/i;
const CUE = /\b(supersedes?|superseded\s+by|replaces?|replaced\s+by|amends?|as\s+amended|notwithstanding|revokes?|repeals?|overrides?)\b/i;

export function detectAmendments(sources: readonly CrossDocumentSource[]): AmendmentItem[] {
  const out: AmendmentItem[] = [];
  for (const source of sources) {
    for (const line of source.text.split(/\r?\n/)) {
      for (const s of splitSentences(line.trim())) {
        const sentence = s.text.trim();
        const cue = CUE.exec(sentence)?.[1]?.toLowerCase().replace(/\s+/g, ' ');
        if (cue === undefined) continue;
        if (cue !== 'notwithstanding' && !STRUCTURE_WORD.test(sentence)) continue;
        const effectiveDate = parseEffectiveDate(sentence);
        out.push({ sourcePath: source.sourcePath, sentence, cue, ...(effectiveDate !== undefined ? { effectiveDate } : {}) });
      }
    }
  }
  return out;
}

// ── conflicts ────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Leaf {
  readonly type?: string;
  readonly field?: string;
  readonly operator?: string;
  readonly value?: number;
  readonly min?: number;
  readonly max?: number;
  readonly unit?: string;
  readonly operands?: readonly Leaf[];
  readonly [k: string]: unknown;
}

const normField = (f: string): string =>
  f
    .toLowerCase()
    .replace(/^(?:the|a|an)\s+/, '')
    .trim();

function canonical(c: Leaf | undefined): string {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x !== null && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, k === 'field' && typeof o[k] === 'string' ? normField(o[k] as string) : walk(o[k])]),
      );
    }
    return typeof x === 'string' ? x.toLowerCase() : x;
  };
  return JSON.stringify(walk(c));
}

interface Interval {
  readonly field: string;
  readonly unit: string | undefined;
  readonly lo: number;
  readonly hi: number;
  readonly loClosed: boolean;
  readonly hiClosed: boolean;
}

function intervalOf(c: Leaf | undefined): Interval | undefined {
  if (c === undefined || typeof c.field !== 'string') return undefined;
  const field = normField(c.field);
  if (c.type === 'range' && typeof c.min === 'number' && typeof c.max === 'number')
    return { field, unit: c.unit, lo: c.min, hi: c.max, loClosed: true, hiClosed: true };
  if (c.type !== 'comparison' || typeof c.value !== 'number') return undefined;
  switch (c.operator) {
    case '>':
      return { field, unit: c.unit, lo: c.value, hi: Infinity, loClosed: false, hiClosed: false };
    case '>=':
      return { field, unit: c.unit, lo: c.value, hi: Infinity, loClosed: true, hiClosed: false };
    case '<':
      return { field, unit: c.unit, lo: -Infinity, hi: c.value, loClosed: false, hiClosed: false };
    case '<=':
      return { field, unit: c.unit, lo: -Infinity, hi: c.value, loClosed: false, hiClosed: true };
    case '==':
      return { field, unit: c.unit, lo: c.value, hi: c.value, loClosed: true, hiClosed: true };
    default:
      return undefined;
  }
}

function overlaps(a: Interval, b: Interval): boolean {
  if (a.field !== b.field || a.unit !== b.unit) return false;
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (lo < hi) return true;
  if (lo > hi) return false;
  const loClosed = (a.lo === lo ? a.loClosed : true) && (b.lo === lo ? b.loClosed : true);
  const hiClosed = (a.hi === hi ? a.hiClosed : true) && (b.hi === hi ? b.hiClosed : true);
  return loClosed && hiClosed;
}

interface RuleView {
  readonly nodeId: string;
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly label: string;
  readonly outcomeType: string;
  readonly condition: Leaf;
}

function resolve(a: RuleView, b: RuleView, policy: PrecedencePolicy | undefined): ConflictResolution {
  if (policy === undefined || a.sourceId === b.sourceId) return { status: 'unresolved' };
  const rank = (v: RuleView): number => {
    const i = policy.order.findIndex((o) => o === v.sourcePath || o === v.sourceId);
    return i < 0 ? Infinity : i;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra === Infinity || rb === Infinity || ra === rb) return { status: 'unresolved' };
  return ra < rb
    ? { status: 'resolved-by-precedence', winner: a.sourcePath, loser: b.sourcePath }
    : { status: 'resolved-by-precedence', winner: b.sourcePath, loser: a.sourcePath };
}

export function detectConflicts(graph: XoirGraph, sources: readonly CrossDocumentSource[], policy?: PrecedencePolicy): ConflictItem[] {
  const pathOf = new Map(sources.map((s) => [s.sourceId, s.sourcePath]));
  const rules: RuleView[] = [];
  for (const kind of ['heuristic', 'decision_node'] as const) {
    for (const node of nodesOfKind(graph, kind)) {
      const p = node.properties as Record<string, unknown>;
      const outcomeType = typeof p['outcomeType'] === 'string' ? p['outcomeType'] : undefined;
      const condition = p['structuredCondition'] as Leaf | undefined;
      if (outcomeType === undefined || !DECISION_OUTCOMES.has(outcomeType) || condition === undefined) continue;
      const sourceId = node.metadata?.sourceRefs?.[0]?.documentPath ?? 'unknown';
      rules.push({
        nodeId: node.id,
        sourceId,
        sourcePath: pathOf.get(sourceId) ?? sourceId,
        label: String(p['action'] ?? p['outcome'] ?? ''),
        outcomeType,
        condition,
      });
    }
  }
  const out: ConflictItem[] = [];
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (a.outcomeType === b.outcomeType) continue;
      let kind: ConflictItem['kind'] | undefined;
      let field: string | undefined;
      if (canonical(a.condition) === canonical(b.condition)) kind = 'identical-condition';
      else {
        const ia = intervalOf(a.condition);
        const ib = intervalOf(b.condition);
        if (ia && ib && overlaps(ia, ib)) {
          kind = 'overlapping-range';
          field = ia.field;
        }
      }
      if (kind === undefined) continue;
      const side = (r: RuleView): ConflictSide => ({
        nodeId: r.nodeId,
        sourcePath: r.sourcePath,
        label: r.label,
        outcomeType: r.outcomeType,
      });
      out.push({
        kind,
        scope: a.sourceId === b.sourceId ? 'within-source' : 'cross-source',
        ...(field !== undefined ? { field } : {}),
        a: side(a),
        b: side(b),
        resolution: resolve(a, b, policy),
      });
    }
  }
  return out;
}

export function analyzeCrossDocument(
  graph: XoirGraph,
  sources: readonly CrossDocumentSource[],
  policy?: PrecedencePolicy,
): CrossDocumentAnalysis {
  return { conflicts: detectConflicts(graph, sources, policy), amendments: detectAmendments(sources) };
}
