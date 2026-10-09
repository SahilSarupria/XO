import type { CapabilityDeclaration, CompatibilityDeclaration, DependencyDeclaration, XoManifest, XoMetadata } from '@xo/types';
import type { PackageBundle } from '../src/types.js';
export declare const sampleCompatibility: CompatibilityDeclaration;
export declare const sampleMetadata: XoMetadata;
export declare const sampleCapability: CapabilityDeclaration;
export declare function buildSampleBundle(overrides?: {
    readonly name?: string;
    readonly version?: string;
    readonly capabilities?: readonly CapabilityDeclaration[];
    readonly dependencies?: readonly DependencyDeclaration[];
}): PackageBundle;
/** Convenience wrapper over {@link buildSampleBundle} for resolver/lockfile tests, which only ever need the manifest, never the full bundle. */
export declare function buildSampleManifest(overrides?: {
    readonly name?: string;
    readonly version?: string;
    readonly dependencies?: readonly DependencyDeclaration[];
}): XoManifest;
//# sourceMappingURL=fixtures.d.ts.map