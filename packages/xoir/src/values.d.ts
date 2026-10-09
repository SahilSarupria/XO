/**
 * The value type every node/edge `properties` and `metadata` bag is
 * restricted to. Keeping this a closed, JSON-shaped union (rather than
 * `unknown`/`any`) is what makes canonical serialization and content
 * hashing (see hashing.ts) deterministic: there is exactly one way to
 * stringify a `XoirValue`, with no risk of a class instance, `Map`, or
 * `Date` silently breaking round-trip equality.
 */
export type XoirValue = string | number | boolean | null | readonly XoirValue[] | {
    readonly [key: string]: XoirValue;
};
export type XoirPropertyBag = Readonly<Record<string, XoirValue>>;
//# sourceMappingURL=values.d.ts.map