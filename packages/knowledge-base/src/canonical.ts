/** Canonical JSON (sorted keys, `undefined` dropped) and `sha256:` digests — the one identity scheme of the BKB. */
import { createHash } from 'node:crypto';

export type Digest = `sha256:${string}`;
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [k: string]: JsonValue };

function normalise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalise(v)));
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[k];
    if (v !== undefined && typeof v !== 'function') out[k] = normalise(v);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value));
}

export function digestOf(value: unknown): Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** A short id: `<prefix>_` + 24 hex characters of the digest of `value`. */
export function idOf(prefix: string, value: unknown): string {
  return `${prefix}_${digestOf(value).slice(7, 31)}`;
}
