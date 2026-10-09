import type { ComponentKind, XoManifest, XoMetadata } from '@xo/types';
declare const COMPONENT_KINDS: readonly ComponentKind[];
/**
 * A structural (not semantic) check that `value` has the shape of an
 * {@link XoManifest} — every field of the right type, present where
 * required. It does NOT check hash correctness, Merkle consistency, or
 * signature validity; those are `PackageValidator`'s job precisely because
 * they can fail independently of shape (a well-formed manifest can still
 * lie about its hashes). Used by the reader to reject obviously-malformed
 * JSON before it's ever handed to the rest of the SDK as a typed value.
 */
export declare function isXoManifest(value: unknown): value is XoManifest;
export declare function isXoMetadata(value: unknown): value is XoMetadata;
export { COMPONENT_KINDS };
//# sourceMappingURL=schema.d.ts.map