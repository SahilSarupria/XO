import { Sha256Hasher, buildMerkleRoot } from '@xo/crypto';
/**
 * Computes the SHA-256 hash of a single component's bytes, in the
 * `sha256:<hex>` form `XoManifest.components[*].hash` expects. Thin
 * wrapper kept separate from `@xo/crypto`'s generic {@link Hasher} so
 * call sites read as "hash this component" rather than "hash these
 * bytes", and so a future component-specific hashing rule (e.g.
 * canonicalizing JSON before hashing) has one place to land.
 */
export function hashComponent(component, hasher = new Sha256Hasher()) {
    return hasher.hash(component.data);
}
/** Hashes every component and returns `[kind, hash]` pairs sorted by component kind, so the result is independent of input order — the same ordering rule {@link ManifestBuilder} uses when it feeds leaves to {@link buildMerkleRoot}. */
export function hashComponents(components, hasher = new Sha256Hasher()) {
    return [...components]
        .sort((a, b) => a.kind.localeCompare(b.kind))
        .map((c) => [c.kind, hashComponent(c, hasher)]);
}
export { buildMerkleRoot };
//# sourceMappingURL=component-hasher.js.map