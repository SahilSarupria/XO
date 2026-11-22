import type { RecordSet } from '@xo/compiler';
import { digestOf, type Digest } from './canonical.js';

/**
 * UW-15 (ADR 0044) — schema drift: has the data a workflow reads changed shape since it was compiled? A renamed, removed or retyped
 * USED column, or a changed format pattern in a used column, is BLOCKING: the run must stop before any effect and say what differs.
 * A new column nothing uses is a warning only. Header names are compared after trimming and case-folding; order does not matter.
 * Deterministic and domain-agnostic: it looks at headers, the type of each column's values and the shape of those values, never at
 * what they mean.
 */
export type DriftKind = 'table_missing' | 'column_missing' | 'type_changed' | 'format_changed' | 'column_added';

export interface ColumnFingerprint {
  /** Normalised: trimmed, whitespace collapsed, case-folded. */
  readonly key: string;
  /** The header as written, for reports. */
  readonly header: string;
  readonly declaredType: string;
  /** The value shape at least 80% of the column's filled cells share (see {@link valueShape}); absent when no shape dominates. */
  readonly shape?: string;
}

export interface SchemaFingerprint {
  readonly columns: readonly ColumnFingerprint[];
  readonly digest: Digest;
}

export interface DriftDifference {
  readonly kind: DriftKind;
  readonly severity: 'blocking' | 'warning';
  /** The header as compiled (or, for an added column, as found now). */
  readonly header: string;
  readonly message: string;
  readonly was?: string;
  readonly now?: string;
  /** For a missing column: the one new column with the same type and shape, which is probably the same column renamed. */
  readonly renamedTo?: string;
}

export interface DriftReport {
  readonly status: 'none' | 'warning' | 'blocking';
  readonly differences: readonly DriftDifference[];
  readonly checkedColumns: number;
  readonly compiledDigest: Digest;
  readonly incomingDigest: Digest;
}

export const normaliseHeader = (h: string): string => h.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** What one value looks like: letters collapse to `a`/`A` runs, digits stay one `9` each, other characters stay. Capped at 24 characters. */
export function valueShape(v: string): string {
  let out = '';
  for (const ch of v.trim().slice(0, 40)) {
    const c = /\p{Ll}/u.test(ch) ? 'a' : /\p{Lu}/u.test(ch) ? 'A' : /\p{N}/u.test(ch) ? '9' : ch;
    if ((c === 'a' || c === 'A') && out.endsWith(c)) continue;
    out += c;
  }
  return out.slice(0, 24);
}

const DOMINANT = 0.8;
const MIN_VALUES = 3;

export function fingerprintRecordSet(rs: RecordSet): SchemaFingerprint {
  const columns = rs.columns.map((col): ColumnFingerprint => {
    const shapes = new Map<string, number>();
    let filled = 0;
    for (const r of rs.records) {
      const raw = r.cells[col.column]?.raw;
      if (raw === undefined || raw.trim() === '') continue;
      filled++;
      const s = valueShape(raw);
      shapes.set(s, (shapes.get(s) ?? 0) + 1);
    }
    const top = [...shapes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const shape = top !== undefined && filled >= MIN_VALUES && top[1] / filled >= DOMINANT ? top[0] : undefined;
    return {
      key: normaliseHeader(col.header),
      header: col.header,
      declaredType: col.declaredType,
      ...(shape !== undefined ? { shape } : {}),
    };
  });
  return { columns, digest: digestOf(columns.map((c) => [c.key, c.declaredType, c.shape ?? null]).sort()) };
}

/**
 * Compares what was compiled with what arrived. `used` names the headers the workflow reads (default: every compiled column).
 * Duplicate headers are compared by their first occurrence.
 */
export function detectDrift(compiled: SchemaFingerprint, incoming: SchemaFingerprint, used?: readonly string[]): DriftReport {
  const usedKeys = new Set((used ?? compiled.columns.map((c) => c.header)).map(normaliseHeader));
  const now = new Map<string, ColumnFingerprint>();
  for (const c of incoming.columns) if (!now.has(c.key)) now.set(c.key, c);
  const was = new Map<string, ColumnFingerprint>();
  for (const c of compiled.columns) if (!was.has(c.key)) was.set(c.key, c);
  const differences: DriftDifference[] = [];
  const unmatchedNow = [...now.values()].filter((c) => !was.has(c.key));
  let checked = 0;
  for (const c of was.values()) {
    if (!usedKeys.has(c.key)) continue;
    checked++;
    const n = now.get(c.key);
    if (n === undefined) {
      const same = unmatchedNow.filter((u) => u.declaredType === c.declaredType && u.shape === c.shape && c.declaredType !== 'empty');
      differences.push({
        kind: 'column_missing',
        severity: 'blocking',
        header: c.header,
        message: `the column "${c.header}" is no longer there${same.length === 1 ? `; "${same[0]!.header}" looks like the same column renamed` : ''}`,
        ...(same.length === 1 ? { renamedTo: same[0]!.header } : {}),
      });
      continue;
    }
    if (n.declaredType !== c.declaredType)
      differences.push({
        kind: 'type_changed',
        severity: 'blocking',
        header: c.header,
        was: c.declaredType,
        now: n.declaredType,
        message: `the values in "${c.header}" were ${c.declaredType} and are now ${n.declaredType}`,
      });
    else if (c.shape !== undefined && n.shape !== c.shape)
      differences.push({
        kind: 'format_changed',
        severity: 'blocking',
        header: c.header,
        was: c.shape,
        now: n.shape ?? 'no common pattern',
        message: `the values in "${c.header}" were written like ${c.shape} and are now ${n.shape === undefined ? 'in no common pattern' : `written like ${n.shape}`}`,
      });
  }
  const renamedTargets = new Set(differences.map((d) => d.renamedTo).filter((x): x is string => x !== undefined));
  for (const n of unmatchedNow)
    if (!usedKeys.has(n.key) && !renamedTargets.has(n.header))
      differences.push({
        kind: 'column_added',
        severity: 'warning',
        header: n.header,
        message: `a new column "${n.header}" appeared; nothing in the workflow uses it`,
      });
  const status = differences.some((d) => d.severity === 'blocking') ? 'blocking' : differences.length > 0 ? 'warning' : 'none';
  return { status, differences, checkedColumns: checked, compiledDigest: compiled.digest, incomingDigest: incoming.digest };
}
