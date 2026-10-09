import type { MountedPackage } from '../registry/mounted-package.js';
import type { CapabilityDescriptor } from './capability-descriptor.js';
/**
 * A derived index over every mounted package's declared capabilities —
 * rebuilt (via {@link fromPackages}) whenever the underlying
 * `PackageRegistry` changes, never mutated in place. Exists so
 * `CapabilityNegotiator` doesn't linearly scan every mounted package's
 * `capabilities` array on every request.
 */
export declare class CapabilityRegistry {
    private readonly byId;
    private readonly flat;
    private constructor();
    static fromPackages(packages: readonly MountedPackage[]): CapabilityRegistry;
    /** Every package offering the capability id exactly, across all mounted versions of all packages. Empty (never throws) if nothing declares it. */
    find(capabilityId: string): readonly CapabilityDescriptor[];
    /**
     * A deterministic, case-insensitive substring match over each
     * capability's `id`, `name`, and `description` — the only matching
     * `CapabilityNegotiator` does at Stage 1 ("pure deterministic
     * planning", no AI reasoning). A later runtime stage may replace or
     * augment this with embedding-based semantic search; this method's
     * contract (same query always returns the same results, in the same
     * order) is what Stage 1's tests and callers can rely on.
     */
    search(query: string): readonly CapabilityDescriptor[];
    all(): readonly CapabilityDescriptor[];
    get size(): number;
}
//# sourceMappingURL=capability-registry.d.ts.map