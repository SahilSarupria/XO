import { Sha256Hasher } from '@xo/crypto';
/**
 * Returns the exact byte sequence that gets hashed/signed for a manifest:
 * every field except `signatures`, key-sorted and stringified
 * deterministically. Signatures are excluded because they're computed
 * *over* this value — including them would make signing self-referential.
 * Exported (not just used internally) so {@link fingerprintManifest} and
 * the signer/verifier in `signing/` are provably hashing/signing the same
 * bytes; duplicating the "how do we serialize a manifest for signing"
 * logic between them would be a correctness bug waiting to happen.
 */
export function signableManifestBytes(manifest) {
    const { signatures: _signatures, ...signable } = manifest;
    return new TextEncoder().encode(canonicalJson(signable));
}
/**
 * A package fingerprint: the content hash of a manifest's signable bytes.
 * Two manifests with identical identity, compatibility, components, and
 * Merkle root — but different signatures, or none at all — fingerprint
 * identically. This is what {@link comparePackages} and the installer's
 * `manifestHash` field use to recognize "this is the same package
 * content" independent of who has (or hasn't) signed it yet.
 */
export function fingerprintManifest(manifest, hasher = new Sha256Hasher()) {
    return hasher.hash(signableManifestBytes(manifest));
}
/** Deterministic JSON stringify: object keys sorted recursively, arrays left in their given order (order is semantically meaningful for arrays like `signatures`/`modelFamilies`, not for object keys). */
export function canonicalJson(value) {
    return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value) {
    if (Array.isArray(value))
        return value.map(sortKeysDeep);
    if (value !== null && typeof value === 'object') {
        const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
        return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
    }
    return value;
}
//# sourceMappingURL=fingerprint.js.map