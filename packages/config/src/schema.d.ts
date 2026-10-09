/**
 * A deliberately small, dependency-free schema DSL. This is foundation
 * plumbing (config loading), not a general-purpose validator — if a
 * package outside @xo/config needs richer validation (unions, refinements,
 * nested objects), reach for a real schema library at that call site
 * rather than growing this one. See docs/adr/0002-language-and-runtime.md.
 */
export type FieldType = 'string' | 'number' | 'boolean' | 'enum';
interface BaseFieldSpec<T> {
    readonly type: FieldType;
    readonly required?: boolean;
    readonly default?: T;
    readonly description?: string;
}
export interface StringFieldSpec extends BaseFieldSpec<string> {
    readonly type: 'string';
}
export interface NumberFieldSpec extends BaseFieldSpec<number> {
    readonly type: 'number';
    readonly min?: number;
    readonly max?: number;
}
export interface BooleanFieldSpec extends BaseFieldSpec<boolean> {
    readonly type: 'boolean';
}
export interface EnumFieldSpec<T extends string = string> extends BaseFieldSpec<T> {
    readonly type: 'enum';
    readonly values: readonly T[];
}
export type FieldSpec = StringFieldSpec | NumberFieldSpec | BooleanFieldSpec | EnumFieldSpec;
export type ConfigSchema = Readonly<Record<string, FieldSpec>>;
/** Infers the runtime shape a schema resolves to, for use as `ConfigOf<typeof mySchema>`. */
export type ConfigOf<S extends ConfigSchema> = {
    [K in keyof S]: S[K] extends EnumFieldSpec<infer T> ? T : S[K]['type'] extends 'number' ? number : S[K]['type'] extends 'boolean' ? boolean : string;
};
export {};
//# sourceMappingURL=schema.d.ts.map