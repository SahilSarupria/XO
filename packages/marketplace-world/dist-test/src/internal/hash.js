/**
 * FNV-1a 32-bit hash. Deterministic, dependency-free, stable across
 * runs and platforms for a given string. Not exported — used only to
 * seed deterministic initial positions, never for anything
 * cryptographic.
 */
export function stableHash(input) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}
/** A deterministic point on a ring, derived only from an id. This is
 * the "stable, explainable fallback" position: an isolated XO with no
 * relationships always lands in the same place for the same id,
 * openly derived (hash → angle) rather than hidden or random. */
export function hashRingPosition(id, center, radius) {
    const angle = (stableHash(id) % 3600) / 3600 * (2 * Math.PI);
    return {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
    };
}
//# sourceMappingURL=hash.js.map