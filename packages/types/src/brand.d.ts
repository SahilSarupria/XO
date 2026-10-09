/**
 * Nominal ("branded") typing. TypeScript is structurally typed by default,
 * which means `PackageId` and `BenchmarkId` would otherwise both collapse to
 * `string` and be silently interchangeable. Every identifier in the XO
 * domain is branded so the compiler rejects that mistake at the call site.
 */
export type Brand<T, B extends string> = T & {
    readonly __brand: B;
};
export declare function brand<T, B extends string>(value: T): Brand<T, B>;
//# sourceMappingURL=brand.d.ts.map