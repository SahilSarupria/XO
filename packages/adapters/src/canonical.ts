import { createHash } from 'node:crypto';

/** Thrown for a value that cannot be given one unambiguous canonical form. Callers must treat it as "refuse", never fall back. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

const MAX_DEPTH = 32;

/**
 * Deterministic JSON for hashing: object keys sorted, no whitespace, arrays ordered. STRICT: anything without one unambiguous JSON form
 * throws — `undefined`, functions, symbols, bigint, non-finite numbers, non-plain objects (Date, Map, class instances), sparse arrays,
 * cycles, and depth over {@link MAX_DEPTH}. (Plain `JSON.stringify` would map several of these to `null` or drop them, so two different
 * inputs could share a digest.) The error message names the path and kind of problem, never the value.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '$', new Set(), 0);
}

function write(v: unknown, path: string, seen: Set<object>, depth: number): string {
  if (depth > MAX_DEPTH) throw new CanonicalizationError(`${path}: nesting too deep`);
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalizationError(`${path}: non-finite number`);
      return Object.is(v, -0) ? '0' : JSON.stringify(v);
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`${path}: unsupported ${typeof v} value`);
  }
  const o = v as object;
  if (seen.has(o)) throw new CanonicalizationError(`${path}: circular reference`);
  seen.add(o);
  try {
    if (Array.isArray(o)) {
      const parts: string[] = [];
      for (let i = 0; i < o.length; i++) {
        if (!(i in o)) throw new CanonicalizationError(`${path}[${i}]: sparse array`);
        parts.push(write(o[i], `${path}[${i}]`, seen, depth + 1));
      }
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(o) as unknown;
    if (proto !== Object.prototype && proto !== null) throw new CanonicalizationError(`${path}: not a plain object`);
    const rec = o as Record<string, unknown>;
    const keys = Object.keys(rec).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${write(rec[k], `${path}.${k}`, seen, depth + 1)}`).join(',')}}`;
  } finally {
    seen.delete(o);
  }
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
