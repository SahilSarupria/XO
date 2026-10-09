import { canonicalJson, compareStrings, getPath, isPlainObject } from './json.js';

/**
 * Text normalization used by every expectation match: lower-case,
 * whitespace collapsed, trimmed. Deliberately minimal — no stemming, no
 * stop-word removal, no fuzzy similarity: a benchmark that "matches"
 * loosely would hide exactly the semantic drift it exists to detect.
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeDeep);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalizeDeep(v);
    return out;
  }
  return value;
}

export function deepEqualNormalized(a: unknown, b: unknown): boolean {
  return canonicalJson(normalizeDeep(a)) === canonicalJson(normalizeDeep(b));
}

/** Every key of `expected` must be present in `actual` with a deep-equal (normalized) value; extra keys in `actual` are allowed. */
export function isSubsetMatch(actual: unknown, expected: Record<string, unknown>): { readonly ok: boolean; readonly mismatches: readonly string[] } {
  const mismatches: string[] = [];
  for (const key of Object.keys(expected).sort(compareStrings)) {
    const got = isPlainObject(actual) ? actual[key] : undefined;
    if (!deepEqualNormalized(got, expected[key])) mismatches.push(`${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(got)}`);
  }
  return { ok: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Predicates over a property bag
// ---------------------------------------------------------------------------

export interface Predicate {
  readonly path: string;
  readonly equals?: unknown;
  readonly contains?: string;
  readonly exists?: boolean;
}

export function evalPredicate(root: unknown, predicate: Predicate): boolean {
  const value = getPath(root, predicate.path);
  if (predicate.exists !== undefined) return (value !== undefined && value !== null) === predicate.exists;
  if (predicate.equals !== undefined) return value !== undefined && deepEqualNormalized(value, predicate.equals);
  if (predicate.contains !== undefined) {
    const needle = normalizeText(predicate.contains);
    if (typeof value === 'string') return normalizeText(value).includes(needle);
    if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && normalizeText(v).includes(needle));
    return false;
  }
  return false;
}

export function evalAll(root: unknown, predicates: readonly Predicate[]): boolean {
  return predicates.every((p) => evalPredicate(root, p));
}

export function describePredicate(p: Predicate): string {
  if (p.exists !== undefined) return `${p.path} ${p.exists ? 'exists' : 'is absent'}`;
  if (p.equals !== undefined) return `${p.path} = ${JSON.stringify(p.equals)}`;
  return `${p.path} contains ${JSON.stringify(p.contains)}`;
}

// ---------------------------------------------------------------------------
// Name matchers (capability / workflow-step identity)
// ---------------------------------------------------------------------------

export type NameMatcher = { readonly equals: string } | { readonly contains: string };

export function matchesName(name: string, matcher: NameMatcher): boolean {
  const n = normalizeText(name);
  return 'equals' in matcher ? n === normalizeText(matcher.equals) : n.includes(normalizeText(matcher.contains));
}

export function describeMatcher(matcher: NameMatcher): string {
  return 'equals' in matcher ? `name = "${matcher.equals}"` : `name contains "${matcher.contains}"`;
}

/**
 * Perfect bipartite assignment of `matchers` onto `candidates` (each
 * candidate used at most once) via augmenting paths — used to decide
 * whether an observed workflow's steps are exactly the expected step
 * set, independent of any ordering. `true` iff every matcher can be
 * assigned a distinct matching candidate AND the two lists have equal
 * length (a perfect matching).
 */
export function perfectAssignment<T>(matchers: readonly NameMatcher[], candidates: readonly T[], nameOf: (candidate: T) => string): boolean {
  if (matchers.length !== candidates.length) return false;
  const owner: number[] = new Array<number>(candidates.length).fill(-1);
  const adjacency = matchers.map((m) => candidates.map((c, i) => (matchesName(nameOf(c), m) ? i : -1)).filter((i) => i >= 0));

  const tryAssign = (m: number, seen: boolean[]): boolean => {
    for (const c of adjacency[m]!) {
      if (seen[c]) continue;
      seen[c] = true;
      if (owner[c] === -1 || tryAssign(owner[c]!, seen)) {
        owner[c] = m;
        return true;
      }
    }
    return false;
  };
  for (let m = 0; m < matchers.length; m++) {
    if (!tryAssign(m, new Array<boolean>(candidates.length).fill(false))) return false;
  }
  return true;
}

/** Set comparison of two string lists under `normalizeText` — order and duplicates irrelevant. */
export function diffNormalizedSets(expected: readonly string[], actual: readonly string[]): { readonly missing: readonly string[]; readonly unexpected: readonly string[] } {
  const exp = new Set(expected.map(normalizeText));
  const act = new Set(actual.map(normalizeText));
  return {
    missing: [...exp].filter((x) => !act.has(x)).sort(compareStrings),
    unexpected: [...act].filter((x) => !exp.has(x)).sort(compareStrings),
  };
}
