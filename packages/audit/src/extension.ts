import { AuditError, ErrorCode } from '@xo/errors';
import { err, ok, type Result } from '@xo/types';

/**
 * Strictly typed, bounded, CLOSED audit extensions (C0.3).
 *
 * An extension is how a domain (e.g. Environment Intelligence) records structured, content-free fields that do not fit
 * the flat `metadata` bag. Rules, enforced by the core — not by the extension author:
 *  - An extension namespace must be registered with the store (`x-<org>-<name>`); an unregistered namespace is rejected.
 *  - The value must match a DECLARATIVE schema field by field. There is no `unknown`, `any` or free-text field kind:
 *    every leaf is an id, an enum member, a count, a boolean, an ISO time, a version, an anchored opaque token, or a list
 *    / object of those. Unknown object members are rejected.
 *  - The GLOBAL secret filter still applies. Field NAMES are checked against the same forbidden-key fragments as
 *    `metadata`, and every `id` / `version` string is checked against the same secret-value patterns (bearer tokens,
 *    JWTs, private keys, provider keys, long opaque blobs). The ONLY exemption is the `opaque` kind, which must match an
 *    explicit anchored pattern (e.g. `sha256:<64 hex>`) declared in the schema and bounded by `maxLength`; it can never
 *    be a free-form string.
 *  - Bounded: total serialized size, list length, and nesting depth are capped.
 */
export type AuditExtensionScalar =
  | { readonly kind: 'id'; readonly maxLength?: number }
  | { readonly kind: 'version' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'count' }
  | { readonly kind: 'bool' }
  | { readonly kind: 'isoTime' }
  | { readonly kind: 'opaque'; readonly pattern: RegExp; readonly maxLength: number };

export type AuditExtensionField =
  | AuditExtensionScalar
  | { readonly kind: 'list'; readonly max: number; readonly of: AuditExtensionScalar }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, AuditExtensionFieldSpec>> };

export type AuditExtensionFieldSpec = AuditExtensionField & {
  readonly optional?: boolean;
  /**
   * TOP-LEVEL fields only. A volatile field is still validated, bounded, filtered and PERSISTED, but is excluded from the
   * content identity used for idempotency/conflict detection. It exists for caller-observed values that legitimately differ
   * between a first attempt and a retry of the SAME logical event (e.g. the caller's clock reading). Everything else about
   * the event must match exactly or the retry is a conflict.
   */
  readonly volatile?: boolean;
};

export interface AuditExtensionSchema {
  readonly namespace: string;
  readonly fields: Readonly<Record<string, AuditExtensionFieldSpec>>;
}
export type AuditExtensionSchemas = Readonly<Record<string, AuditExtensionSchema>>;

export const MAX_EXTENSION_BYTES = 262_144;
export const MAX_EXTENSION_LIST = 10_000;
const MAX_DEPTH = 4;
const NAMESPACE_RE = /^x-[a-z0-9]{1,16}-[a-z0-9-]{1,32}$/;
const FIELD_KEY_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
const ID_EXT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,199}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

/** The global filters, shared with `event.ts` (injected to avoid a cycle). */
export interface GlobalFilters {
  readonly forbiddenKeyFragments: readonly string[];
  readonly reservedKeys: ReadonlySet<string>;
  readonly secretValuePatterns: readonly RegExp[];
}

const invalid = (why: string): AuditError => new AuditError(ErrorCode.AUDIT_EVENT_INVALID, `invalid audit event: ${why}`);

function checkKeyName(key: string, filters: GlobalFilters): string | undefined {
  if (!FIELD_KEY_RE.test(key)) return 'an extension field name is malformed';
  const lower = key.toLowerCase();
  if (filters.reservedKeys.has(lower)) return 'an extension field name is reserved for trusted fields';
  if (filters.forbiddenKeyFragments.some((f) => lower.includes(f))) return 'an extension field name names forbidden (sensitive) content';
  return undefined;
}

/** Validates a schema itself, so a schema author cannot declare a sensitive-named field or an unbounded one. */
export function validateExtensionSchema(schema: AuditExtensionSchema, filters: GlobalFilters): Result<AuditExtensionSchema, AuditError> {
  if (!NAMESPACE_RE.test(schema.namespace)) return err(invalid('extension namespace must look like x-<org>-<name>'));
  const walk = (fields: Readonly<Record<string, AuditExtensionFieldSpec>>, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) return 'extension schema is nested too deeply';
    for (const [key, spec] of Object.entries(fields)) {
      const bad = checkKeyName(key, filters);
      if (bad !== undefined) return bad;
      if (spec.volatile === true && depth > 1) return 'only top-level extension fields can be volatile';
      if (spec.kind === 'list' && !(spec.max >= 1 && spec.max <= MAX_EXTENSION_LIST)) return 'extension list bound is out of range';
      if (spec.kind === 'opaque' && !(spec.maxLength >= 1 && spec.maxLength <= 200)) return 'extension opaque bound is out of range';
      if (spec.kind === 'opaque' && !(spec.pattern.source.startsWith('^') && spec.pattern.source.endsWith('$')))
        return 'extension opaque pattern must be anchored';
      if (spec.kind === 'object') {
        const inner = walk(spec.fields, depth + 1);
        if (inner !== undefined) return inner;
      }
    }
    return undefined;
  };
  const bad = walk(schema.fields, 1);
  return bad === undefined ? ok(schema) : err(invalid(bad));
}

function scalar(spec: AuditExtensionScalar, v: unknown, filters: GlobalFilters): unknown | typeof FAIL {
  switch (spec.kind) {
    case 'id': {
      if (typeof v !== 'string' || v.length > (spec.maxLength ?? 200) || !ID_EXT_RE.test(v)) return FAIL;
      return filters.secretValuePatterns.some((re) => re.test(v)) ? FAIL : v;
    }
    case 'version':
      return typeof v === 'string' && VERSION_RE.test(v) && !filters.secretValuePatterns.some((re) => re.test(v)) ? v : FAIL;
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v) ? v : FAIL;
    case 'count':
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : FAIL;
    case 'bool':
      return typeof v === 'boolean' ? v : FAIL;
    case 'isoTime':
      return typeof v === 'string' && ISO_RE.test(v) ? v : FAIL;
    case 'opaque':
      // Anchored at MATCH time, so a pattern whose source merely starts with ^ and ends with $ (e.g. an alternation
      // `^a|b$`) still has to match the WHOLE value.
      return typeof v === 'string' && v.length <= spec.maxLength && fullMatch(spec.pattern, v) ? v : FAIL;
  }
}
const FAIL = Symbol('fail');
function fullMatch(pattern: RegExp, value: string): boolean {
  return new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, '')).test(value);
}
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function field(spec: AuditExtensionField, v: unknown, filters: GlobalFilters, path: string): { value: unknown } | { fail: string } {
  if (spec.kind === 'list') {
    if (!Array.isArray(v) || v.length > spec.max) return { fail: path };
    const out: unknown[] = [];
    for (const item of v) {
      const r = scalar(spec.of, item, filters);
      if (r === FAIL) return { fail: path };
      out.push(r);
    }
    return { value: Object.freeze(out) };
  }
  if (spec.kind === 'object') {
    if (!isRecord(v)) return { fail: path };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) if (!(key in spec.fields)) return { fail: `${path}.unknown` };
    for (const [key, sub] of Object.entries(spec.fields)) {
      const raw = v[key];
      if (raw === undefined) {
        if (sub.optional === true) continue;
        return { fail: `${path}.${key}` };
      }
      const r = field(sub, raw, filters, `${path}.${key}`);
      if ('fail' in r) return r;
      out[key] = r.value;
    }
    return { value: Object.freeze(out) };
  }
  const r = scalar(spec, v, filters);
  return r === FAIL ? { fail: path } : { value: r };
}

/** Validates one registered extension value; returns a fresh frozen copy containing ONLY declared members. */
export function validateExtensionValue(
  schema: AuditExtensionSchema,
  value: unknown,
  filters: GlobalFilters,
): Result<Readonly<Record<string, unknown>>, AuditError> {
  const r = field({ kind: 'object', fields: schema.fields }, value, filters, schema.namespace);
  if ('fail' in r) return err(invalid(`extension ${schema.namespace} does not satisfy its schema at "${r.fail.slice(0, 60)}"`));
  const bytes = Buffer.byteLength(JSON.stringify(r.value), 'utf8');
  if (bytes > MAX_EXTENSION_BYTES) return err(invalid(`extension ${schema.namespace} is too large`));
  return ok(r.value as Readonly<Record<string, unknown>>);
}

/** Removes schema-declared volatile top-level fields so they do not take part in content identity. */
export function stripVolatileExtensions(
  extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  schemas: AuditExtensionSchemas,
): Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined {
  if (extensions === undefined) return undefined;
  const out: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [ns, value] of Object.entries(extensions)) {
    const schema = schemas[ns];
    const volatile = new Set(
      Object.entries(schema?.fields ?? {})
        .filter(([, s]) => s.volatile === true)
        .map(([k]) => k),
    );
    out[ns] = Object.fromEntries(Object.entries(value).filter(([k]) => !volatile.has(k)));
  }
  return out;
}
