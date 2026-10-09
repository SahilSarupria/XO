import { createHash } from 'node:crypto';

/**
 * Canonical (key-sorted, `undefined`-free) JSON — the single serialization
 * every fingerprint and every order-independence comparison in this
 * package goes through, so two structurally equal values always
 * serialize to the same bytes regardless of object key insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function fingerprintOf(value: unknown): string {
  return sha256Hex(canonicalJson(value)).slice(0, 16);
}

/** Reads a dot-separated path out of nested plain objects; `undefined` when any segment is absent. Array indices are not addressable — expectations address named properties only. */
export function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Total order on strings independent of locale — used for every "sort so the result does not depend on input order" step. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
