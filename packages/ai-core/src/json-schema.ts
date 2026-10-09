/**
 * A minimal JSON-Schema-*subset* — object/array/string/number/boolean,
 * `properties`/`required`/`items`/`enum`, nothing more (no `oneOf`,
 * `$ref`, numeric ranges, string patterns). This is deliberately small
 * for the same reason `@xo/config`'s hand-rolled schema DSL is small
 * (see that package's `schema.ts`): it exists to do exactly two jobs —
 * describe a capability's output shape well enough for a provider
 * adapter to request structured output from a vendor API, and validate a
 * parsed JSON response against that shape before a caller ever sees it —
 * not to be a general-purpose validation library.
 */
export type JsonSchema =
  | { readonly type: 'object'; readonly properties: Readonly<Record<string, JsonSchema>>; readonly required: readonly string[] }
  | { readonly type: 'array'; readonly items: JsonSchema }
  | { readonly type: 'string'; readonly enum?: readonly string[] }
  | { readonly type: 'number' }
  | { readonly type: 'boolean' };

export interface SchemaValidationIssue {
  readonly path: string;
  readonly message: string;
}

function validateAt(schema: JsonSchema, value: unknown, path: string, issues: SchemaValidationIssue[]): void {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        issues.push({ path, message: `expected an object, got ${describeType(value)}` });
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required) {
        if (!(key in obj)) issues.push({ path: `${path}.${key}`, message: 'missing required property' });
      }
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) validateAt(propSchema, obj[key], `${path}.${key}`, issues);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        issues.push({ path, message: `expected an array, got ${describeType(value)}` });
        return;
      }
      value.forEach((item, i) => validateAt(schema.items, item, `${path}[${i}]`, issues));
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        issues.push({ path, message: `expected a string, got ${describeType(value)}` });
        return;
      }
      if (schema.enum && !schema.enum.includes(value)) {
        issues.push({ path, message: `expected one of [${schema.enum.join(', ')}], got "${value}"` });
      }
      return;
    }
    case 'number':
      if (typeof value !== 'number') issues.push({ path, message: `expected a number, got ${describeType(value)}` });
      return;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push({ path, message: `expected a boolean, got ${describeType(value)}` });
      return;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function validateJsonSchema(schema: JsonSchema, value: unknown): readonly SchemaValidationIssue[] {
  const issues: SchemaValidationIssue[] = [];
  validateAt(schema, value, '$', issues);
  return issues;
}
