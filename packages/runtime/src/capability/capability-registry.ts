import type { MountedPackage } from '../registry/mounted-package.js';
import type { CapabilityDescriptor } from './capability-descriptor.js';

/**
 * A derived index over every mounted package's declared capabilities —
 * rebuilt (via {@link fromPackages}) whenever the underlying
 * `PackageRegistry` changes, never mutated in place. Exists so
 * `CapabilityNegotiator` doesn't linearly scan every mounted package's
 * `capabilities` array on every request.
 */
export class CapabilityRegistry {
  private constructor(
    private readonly byId: ReadonlyMap<string, readonly CapabilityDescriptor[]>,
    private readonly flat: readonly CapabilityDescriptor[],
  ) {}

  static fromPackages(packages: readonly MountedPackage[]): CapabilityRegistry {
    const byId = new Map<string, CapabilityDescriptor[]>();
    const flat: CapabilityDescriptor[] = [];
    // `packages` is expected pre-sorted (PackageRegistry.all() sorts by
    // name then version), so both `flat` and each `byId` bucket come out
    // in a deterministic order without this class needing its own
    // comparator.
    for (const pkg of packages) {
      for (const declaration of pkg.capabilities.map((c) => c.declaration)) {
        const descriptor: CapabilityDescriptor = { declaration, packageName: pkg.name, packageVersion: pkg.version };
        flat.push(descriptor);
        const bucket = byId.get(declaration.id);
        if (bucket) bucket.push(descriptor);
        else byId.set(declaration.id, [descriptor]);
      }
    }
    return new CapabilityRegistry(byId, flat);
  }

  /** Every package offering the capability id exactly, across all mounted versions of all packages. Empty (never throws) if nothing declares it. */
  find(capabilityId: string): readonly CapabilityDescriptor[] {
    return this.byId.get(capabilityId) ?? [];
  }

  /**
   * A deterministic, case-insensitive substring match over each
   * capability's `id`, `name`, and `description` — the only matching
   * `CapabilityNegotiator` does at Stage 1 ("pure deterministic
   * planning", no AI reasoning). A later runtime stage may replace or
   * augment this with embedding-based semantic search; this method's
   * contract (same query always returns the same results, in the same
   * order) is what Stage 1's tests and callers can rely on.
   */
  search(query: string): readonly CapabilityDescriptor[] {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return [];
    return this.flat.filter(
      (d) => d.declaration.id.toLowerCase().includes(needle) || d.declaration.name.toLowerCase().includes(needle) || d.declaration.description.toLowerCase().includes(needle),
    );
  }

  all(): readonly CapabilityDescriptor[] {
    return this.flat;
  }

  get size(): number {
    return this.flat.length;
  }
}
