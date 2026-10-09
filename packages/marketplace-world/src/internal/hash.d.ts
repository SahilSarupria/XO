/**
 * FNV-1a 32-bit hash. Deterministic, dependency-free, stable across
 * runs and platforms for a given string. Not exported — used only to
 * seed deterministic initial positions, never for anything
 * cryptographic.
 */
export declare function stableHash(input: string): number;
/** A deterministic point on a ring, derived only from an id. This is
 * the "stable, explainable fallback" position: an isolated XO with no
 * relationships always lands in the same place for the same id,
 * openly derived (hash → angle) rather than hidden or random. */
export declare function hashRingPosition(id: string, center: {
    x: number;
    y: number;
}, radius: number): {
    x: number;
    y: number;
};
//# sourceMappingURL=hash.d.ts.map