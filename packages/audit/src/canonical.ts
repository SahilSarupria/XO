/** INTERNAL. Canonical (sorted-key) JSON for hashing and content-equality. `undefined` members are omitted. */
import { createHash, createHmac } from 'node:crypto';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** SHA-256, or HMAC-SHA-256 when a key is supplied. */
export function digest(key: Uint8Array | undefined, text: string): string {
  return key === undefined ? createHash('sha256').update(text).digest('hex') : createHmac('sha256', key).update(text).digest('hex');
}
