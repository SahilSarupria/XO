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
export type JsonSchema = {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, JsonSchema>>;
    readonly required: readonly string[];
} | {
    readonly type: 'array';
    readonly items: JsonSchema;
} | {
    readonly type: 'string';
    readonly enum?: readonly string[];
} | {
    readonly type: 'number';
} | {
    readonly type: 'boolean';
};
export interface SchemaValidationIssue {
    readonly path: string;
    readonly message: string;
}
export declare function validateJsonSchema(schema: JsonSchema, value: unknown): readonly SchemaValidationIssue[];
//# sourceMappingURL=json-schema.d.ts.map