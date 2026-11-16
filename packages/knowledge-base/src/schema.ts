/**
 * The schema dialect packs use for typed payloads: a strict subset of JSON Schema (object, array, string, number,
 * integer, boolean, null; required, enum, minimum/maximum, minLength/maxLength, pattern, items, additionalProperties,
 * nullable via a type list). A construct outside the subset is refused when the schema is checked, never ignored — a
 * schema that silently validates less than it says would be worse than none.
 */
export interface SchemaNode {
  readonly type?: SchemaType | readonly SchemaType[];
  readonly properties?: { readonly [k: string]: SchemaNode };
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: SchemaNode;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly description?: string;
}

type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

const KNOWN = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'description',
]);

/** Constructs in `schema` the dialect does not support (each one is a reason to refuse the schema). */
export function unsupportedSchemaConstructs(schema: SchemaNode, path = '$'): readonly string[] {
  const out: string[] = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) out.push(`${path}: "${k}" is not supported`);
  for (const [k, v] of Object.entries(schema.properties ?? {})) out.push(...unsupportedSchemaConstructs(v, `${path}.${k}`));
  if (schema.items !== undefined) out.push(...unsupportedSchemaConstructs(schema.items, `${path}[]`));
  if (schema.pattern !== undefined) {
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      out.push(`${path}: pattern is not a valid regular expression`);
    }
  }
  return out;
}

function typeOf(v: unknown): SchemaType {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v as SchemaType;
}

/** Problems with `value` against `schema` (empty when it conforms). */
export function validateAgainstSchema(value: unknown, schema: SchemaNode, path = '$'): readonly string[] {
  const unsupported = unsupportedSchemaConstructs(schema, path);
  if (unsupported.length > 0) return unsupported;
  const out: string[] = [];
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (actual === 'integer' && allowed.includes('number'));
    if (!ok) return [`${path}: expected ${allowed.join(' or ')}, got ${actual}`];
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean | null))
    out.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below the minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: above the maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) out.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items !== undefined)
    value.forEach((v, i) => out.push(...validateAgainstSchema(v, schema.items!, `${path}[${i}]`)));
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (!(r in obj)) out.push(`${path}.${r}: required`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub !== undefined) out.push(...validateAgainstSchema(v, sub, `${path}.${k}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${k}: not allowed`);
    }
  }
  return out;
}
