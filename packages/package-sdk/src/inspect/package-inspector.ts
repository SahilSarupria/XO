import type { Hasher } from '@xo/crypto';
import { Sha256Hasher } from '@xo/crypto';
import { fingerprintManifest } from '../hashing/fingerprint.js';
import { resolveCompatibility } from '../manifest/compatibility.js';
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
export function inspectBundle(bundle: PackageBundle, hasher: Hasher = new Sha256Hasher()): PackageInspection {
  const components: ResolvedComponent[] = bundle.components.map((c) => ({
    kind: c.kind,
    path: c.path,
    hash: hasher.hash(c.data),
    required: c.required,
    size: c.data.byteLength,
  }));

  return {
    name: bundle.manifest.name,
    version: bundle.manifest.version,
    creatorDid: bundle.manifest.creatorDid,
    fingerprint: fingerprintManifest(bundle.manifest, hasher),
    ...(bundle.manifest.merkleRoot ? { merkleRoot: bundle.manifest.merkleRoot } : {}),
    signatureCount: bundle.manifest.signatures?.length ?? 0,
    components,
    totalComponentBytes: components.reduce((sum, c) => sum + c.size, 0),
    declaredFamilies: bundle.manifest.compatibility.modelFamilies.map((mf) => mf.family),
  };
}

/** Resolves compatibility for every host profile the caller supplies, in one call — a convenience over calling `resolveCompatibility` per host when a caller wants the full compatibility-per-family picture the marketplace listing shows (SPECIFICATION.md §2.2: "This XO reaches L3 on Claude, L1 on generic chat models"). */
export function inspectCompatibilityMatrix(bundle: PackageBundle, hosts: readonly HostProfile[]): ReadonlyMap<string, CompatibilityResolution> {
  return new Map(hosts.map((host) => [host.family, resolveCompatibility(bundle.manifest, host)]));
}
