/**
 * Canonical JSON and digests for pre-execution artifacts (ADR 0029 decision 15).
 *
 * One textual form per value: object keys sorted, arrays in order, `undefined` members dropped (as `JSON.stringify` does),
 * non-finite numbers as `null`. Every digest in this package is `sha256:` + the lowercase hex SHA-256 of that form, so two
 * artifacts with the same content have the same digest on every surface and every run.
 */
import { createHash } from 'node:crypto';

export type Digest = `sha256:${string}`;

function normalise(value: unknown, drop: ReadonlySet<string>): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (value instanceof Uint8Array) return { $bytesSha256: createHash('sha256').update(value).digest('hex') };
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : normalise(v, drop)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (drop.has(key)) continue;
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined || typeof v === 'function') continue;
    out[key] = normalise(v, drop);
  }
  return out;
}

/** The canonical JSON text of `value`, leaving out any member whose key is in `drop` at any depth. */
export function canonicalJson(value: unknown, drop: Iterable<string> = []): string {
  return JSON.stringify(normalise(value, new Set(drop)));
}

/** `sha256:` + hex SHA-256 of the canonical JSON of `value`. */
export function digestOf(value: unknown, drop: Iterable<string> = []): Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value, drop)).digest('hex')}`;
}

/** `sha256:` + hex SHA-256 of raw bytes. */
export function digestOfBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A plain JSON copy of `value` (dates, maps and class instances become what `JSON.stringify` makes of them). */
export function toPlainJson<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as unknown;
}
