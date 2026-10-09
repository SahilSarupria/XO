import type { Hasher } from '@xo/crypto';
import type { CompatibilityResolution, HostProfile, PackageBundle, ResolvedComponent } from '../types.js';
export interface PackageInspection {
    readonly name: string;
    readonly version: string;
    readonly creatorDid: string;
    readonly fingerprint: string;
    readonly merkleRoot?: string;
    readonly signatureCount: number;
    readonly components: readonly ResolvedComponent[];
    readonly totalComponentBytes: number;
    readonly declaredFamilies: readonly string[];
}
/** A read-only summary of a {@link PackageBundle} — component sizes/hashes, signature count, fingerprint, declared compatibility — for tools that need to *show* a package (a CLI `inspect` command, a Studio detail pane) without needing to know the internals of the manifest or archive layers. */
export declare function inspectBundle(bundle: PackageBundle, hasher?: Hasher): PackageInspection;
/** Resolves compatibility for every host profile the caller supplies, in one call — a convenience over calling `resolveCompatibility` per host when a caller wants the full compatibility-per-family picture the marketplace listing shows (SPECIFICATION.md §2.2: "This XO reaches L3 on Claude, L1 on generic chat models"). */
export declare function inspectCompatibilityMatrix(bundle: PackageBundle, hosts: readonly HostProfile[]): ReadonlyMap<string, CompatibilityResolution>;
//# sourceMappingURL=package-inspector.d.ts.map