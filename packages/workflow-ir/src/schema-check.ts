/**
 * A small JSON Schema checker covering exactly the keywords `WORKFLOW_SCHEMA`
 * uses. It exists so the published schema file and the runtime validator can
 * never drift: structural validation is *driven by* the schema. It is not a
 * general-purpose validator and refuses (throws) on a keyword it does not know,
 * so extending the schema without extending this checker fails loudly in tests
 * instead of silently allowing documents through.
 */

export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

type S = Readonly<Record<string, unknown>>;

const KNOWN = new Set([
  '$schema',
  '$id',
  'title',
  'type',
  'const',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'oneOf',
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** The property (if any) that every `oneOf` branch pins with a `const`: it discriminates the union and lets us report precise errors. */
function discriminator(branches: readonly S[]): string | undefined {
  const first = branches[0]?.['properties'];
  if (!isObj(first)) return undefined;
  for (const name of Object.keys(first)) {
    const ok = branches.every((b) => {
      const props = b['properties'];
      return isObj(props) && isObj(props[name]) && 'const' in (props[name] as S);
    });
    if (ok) return name;
  }
  return undefined;
}

export function checkSchema(schema: S, value: unknown, path = '$', out: SchemaIssue[] = []): SchemaIssue[] {
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`schema-check: unsupported schema keyword "${k}" at ${path}`);
  const add = (message: string): void => {
    out.push({ path, message });
  };

  if (schema['oneOf'] !== undefined) {
    const branches = schema['oneOf'] as readonly S[];
    const disc = discriminator(branches);
    if (disc !== undefined) {
      if (!isObj(value)) {
        add(`expected an object, got ${typeOf(value)}`);
        return out;
      }
      const allowed = branches.map((b) => ((b['properties'] as S)[disc] as S)['const'] as string);
      const picked = branches.find((b) => ((b['properties'] as S)[disc] as S)['const'] === value[disc]);
      if (picked === undefined) {
        out.push({ path: `${path}.${disc}`, message: `unknown ${disc} ${JSON.stringify(value[disc])}; allowed: ${allowed.join(', ')}` });
        return out;
      }
      return checkSchema(picked, value, path, out);
    }
    const attempts = branches.map((b) => checkSchema(b, value, path, []));
    if (attempts.some((a) => a.length === 0)) return out;
    const best = attempts.reduce((a, b) => (b.length < a.length ? b : a));
    add(`matches none of the allowed forms (closest: ${best.map((i) => `${i.path}: ${i.message}`).join('; ')})`);
    return out;
  }

  if (schema['const'] !== undefined && stable(schema['const']) !== stable(value)) {
    add(`must equal ${JSON.stringify(schema['const'])}`);
    return out;
  }
  if (schema['enum'] !== undefined && !(schema['enum'] as readonly unknown[]).some((e) => stable(e) === stable(value))) {
    add(`must be one of ${(schema['enum'] as readonly unknown[]).map((e) => JSON.stringify(e)).join(', ')}`);
    return out;
  }
  if (schema['type'] !== undefined) {
    const types = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    if (!types.some((t) => typeMatches(value, t))) {
      add(`expected ${types.join(' | ')}, got ${typeOf(value)}`);
      return out;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength'])
      add(`shorter than ${schema['minLength']} characters`);
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) add(`longer than ${schema['maxLength']} characters`);
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value))
      add(`does not match pattern ${schema['pattern']}`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) add('must be a finite number');
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) add(`must be >= ${schema['minimum']}`);
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) add(`must be <= ${schema['maximum']}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) add(`needs at least ${schema['minItems']} item(s)`);
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) add(`has more than ${schema['maxItems']} items`);
    if (schema['uniqueItems'] === true && new Set(value.map(stable)).size !== value.length) add('items must be unique');
    if (isObj(schema['items'])) value.forEach((v, i) => checkSchema(schema['items'] as S, v, `${path}[${i}]`, out));
  }
  if (isObj(value)) {
    const keys = Object.keys(value);
    if (typeof schema['minProperties'] === 'number' && keys.length < schema['minProperties'])
      add(`needs at least ${schema['minProperties']} propert(ies)`);
    if (typeof schema['maxProperties'] === 'number' && keys.length > schema['maxProperties'])
      add(`has more than ${schema['maxProperties']} properties`);
    const props = isObj(schema['properties']) ? (schema['properties'] as S) : {};
    for (const r of (schema['required'] as readonly string[] | undefined) ?? [])
      if (!(r in value)) out.push({ path: `${path}.${r}`, message: 'is required' });
    for (const k of keys) {
      const sub = props[k];
      if (isObj(sub)) checkSchema(sub, value[k], `${path}.${k}`, out);
      else if (schema['additionalProperties'] === false)
        out.push({ path: `${path}.${k}`, message: 'unknown field (not part of this format version)' });
      else if (isObj(schema['additionalProperties'])) checkSchema(schema['additionalProperties'] as S, value[k], `${path}.${k}`, out);
    }
  }
  return out;
}
