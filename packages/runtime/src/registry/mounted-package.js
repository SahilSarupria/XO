import { compareVersionStrings } from '../util/version-order.js';
/**
 * An immutable, copy-on-write registry of mounted packages, keyed by
 * name then version — the data structure `PackageLoader` builds and
 * `CapabilityRegistry`/`CapabilityNegotiator` read from. Every mutating
 * method returns a *new* `PackageRegistry`; the original is never
 * touched, mirroring `ManifestBuilder`'s style in `@xo/package-sdk`.
 * Multiple versions of the same package name coexist by construction —
 * there's no "active version" concept here (that's `@xo/package-sdk`'s
 * install-time concern); every mounted version is simultaneously live.
 */
export class PackageRegistry {
    byNameVersion;
    constructor(byNameVersion) {
        this.byNameVersion = byNameVersion;
    }
    static empty() {
        return new PackageRegistry(new Map());
    }
    withMounted(pkg) {
        const next = new Map(this.byNameVersion);
        const versions = new Map(next.get(pkg.name) ?? []);
        versions.set(pkg.version, pkg);
        next.set(pkg.name, versions);
        return new PackageRegistry(next);
    }
    withoutMounted(name, version) {
        if (!this.has(name, version))
            return this;
        const next = new Map(this.byNameVersion);
        const versions = new Map(next.get(name));
        versions.delete(version);
        if (versions.size === 0)
            next.delete(name);
        else
            next.set(name, versions);
        return new PackageRegistry(next);
    }
    get(name, version) {
        return this.byNameVersion.get(name)?.get(version);
    }
    has(name, version) {
        return this.byNameVersion.get(name)?.has(version) ?? false;
    }
    /** Every mounted version of `name`, in insertion order. Empty if `name` was never mounted (never throws). */
    versionsOf(name) {
        return [...(this.byNameVersion.get(name)?.values() ?? [])];
    }
    /** Every mounted package across every name and version, sorted deterministically by name then version so callers never depend on `Map` insertion order (see `@xo/package-sdk`'s `compareSemVer` for the version ordering). */
    all() {
        return [...this.byNameVersion.values()]
            .flatMap((versions) => [...versions.values()])
            .sort((a, b) => (a.name === b.name ? compareVersionStrings(a.version, b.version) : a.name.localeCompare(b.name)));
    }
    get packageCount() {
        return this.byNameVersion.size;
    }
    get mountCount() {
        let total = 0;
        for (const versions of this.byNameVersion.values())
            total += versions.size;
        return total;
    }
}
//# sourceMappingURL=mounted-package.js.map