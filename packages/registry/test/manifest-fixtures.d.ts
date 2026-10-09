import type { XoManifest } from '@xo/types';
import { type PackageBundle } from '@xo/package-sdk';
/**
 * Builds a small, real, `merkleRoot`-bearing `PackageBundle` via
 * `@xo/package-sdk`'s own `ManifestBuilder` — mirroring
 * `package-sdk/test/fixtures.ts`'s `buildSampleBundle` (that file lives
 * under `package-sdk/test/`, so it isn't importable from another
 * package; this is the same construction, kept local to this package's
 * tests). Every registry test that needs "a real, verifiable manifest"
 * goes through this rather than hand-writing a manifest-shaped object
 * literal, so tests exercise the same content-addressing/hashing path
 * production code does.
 */
export declare function buildFixtureBundle(overrides?: {
    readonly name?: string;
    readonly version?: string;
    readonly creatorDid?: string;
}): PackageBundle;
export declare function buildFixtureManifest(overrides?: {
    readonly name?: string;
    readonly version?: string;
    readonly creatorDid?: string;
}): XoManifest;
//# sourceMappingURL=manifest-fixtures.d.ts.map