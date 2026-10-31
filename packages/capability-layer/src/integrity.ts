import { Sha256Hasher, buildMerkleRoot } from '@xo/crypto';
import { evaluatePackageTrust, hashComponent, type PackageBundle, type PackageTrustPolicy, type TrustVerdict } from '@xo/package-sdk';

/** Thrown by `createCapabilityLayer` when a bundle fails verification. The layer never exposes content from a bundle it rejected. */
export class BundleIntegrityError extends Error {
  constructor(
    readonly problems: readonly string[],
    readonly trust?: TrustVerdict,
  ) {
    super(`package rejected: ${problems.join('; ')}`);
    this.name = 'BundleIntegrityError';
  }
}

export interface IntegrityOptions {
  /**
   * `enforce` (default): every component must be declared in the manifest, hash to the declared value, and the manifest must carry a Merkle root that matches.
   * `allow-unsealed`: only for hand-built test bundles with no `merkleRoot`; hashes that ARE declared are still checked.
   */
  readonly integrity?: 'enforce' | 'allow-unsealed';
  /** When supplied the package's signatures are verified against the operator's trust policy and the package is refused unless the verdict is acceptable. */
  readonly trust?: PackageTrustPolicy;
  readonly now?: () => Date;
}

/** Verifies content integrity (component hashes + Merkle root) and, when a policy is supplied, signatures. Returns the trust verdict if one was computed. Throws {@link BundleIntegrityError}. */
export function verifyBundle(bundle: PackageBundle, options: IntegrityOptions = {}): TrustVerdict | undefined {
  const problems: string[] = [];
  const hasher = new Sha256Hasher();
  const { manifest } = bundle;
  for (const c of bundle.components) {
    const entry = manifest.components[c.kind];
    if (entry === undefined) {
      problems.push(`component "${c.kind}" is present but not declared in the manifest`);
      continue;
    }
    if (hashComponent(c, hasher) !== entry.hash) problems.push(`component "${c.kind}" does not match its declared hash`);
  }
  const mode = options.integrity ?? 'enforce';
  if (manifest.merkleRoot === undefined || manifest.merkleRoot === '') {
    if (mode === 'enforce') problems.push('manifest has no merkleRoot');
  } else {
    const leaves = Object.entries(manifest.components)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, e]) => e.hash);
    if (leaves.length === 0 || buildMerkleRoot(leaves, hasher) !== manifest.merkleRoot)
      problems.push('manifest merkleRoot does not match the declared component hashes');
  }
  let verdict: TrustVerdict | undefined;
  if (options.trust !== undefined) {
    verdict = evaluatePackageTrust(manifest, options.trust, options.now?.());
    if (!verdict.acceptable)
      problems.push(...verdict.failures.map((f) => `trust: ${f.code}: ${f.message}`), `trust status ${verdict.status}`);
  }
  if (problems.length > 0) throw new BundleIntegrityError(problems, verdict);
  return verdict;
}
