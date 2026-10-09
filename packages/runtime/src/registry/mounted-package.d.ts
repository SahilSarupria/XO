import type { XoManifest } from '@xo/types';
import type { CapabilityDescriptor } from '../capability/capability-descriptor.js';
import type { MountId } from '../ids.js';
/**
 * A package the runtime has verified and loaded — the OS-loading-an-
 * application analogy Runtime Stage 1 is scoped to. Host-agnostic by
 * design: mounting doesn't know or care which model family will
 * eventually use it, unlike `@xo/runtime-core`'s `Mounter` interface
 * (whose `mount(packageId, hostFamily)` signature bakes host resolution
 * into the mount itself — that's a later runtime stage's per-request
 * concern, resolved by `CapabilityNegotiator` against each
 * `ExecutionRequest`'s own `HostProfile`, not fixed once at mount time).
 * A single `MountedPackage` can therefore serve requests from any number
 * of different hosts, each resolving to its own compatibility level.
 *
 * Immutable: constructed once via `Object.freeze` by `PackageLoader` and
 * never mutated afterward. "Reloading" a package produces a new
 * `MountedPackage` (new `mountId`), never mutates an existing one in
 * place.
 */
export interface MountedPackage {
    /** Unique per mount operation — two mounts of the same name@version (e.g. after an unmount/remount) get different `mountId`s, so a stale reference to an unmounted instance is never silently confused with its replacement. */
    readonly mountId: MountId;
    readonly name: string;
    readonly version: string;
    readonly manifest: XoManifest;
    /** Every capability this mount exposes, read directly from `manifest.capabilities` (never inferred from `metadata.json`) and enriched with this package's own name/version. */
    readonly capabilities: readonly CapabilityDescriptor[];
    readonly mountedAt: string;
    /** The manifest's content fingerprint (`fingerprintManifest`, `@xo/package-sdk`) at mount time — lets a caller notice, without re-verifying, if a later-read manifest for the same name@version has drifted. */
    readonly manifestHash: string;
}
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
export declare class PackageRegistry {
    private readonly byNameVersion;
    private constructor();
    static empty(): PackageRegistry;
    withMounted(pkg: MountedPackage): PackageRegistry;
    withoutMounted(name: string, version: string): PackageRegistry;
    get(name: string, version: string): MountedPackage | undefined;
    has(name: string, version: string): boolean;
    /** Every mounted version of `name`, in insertion order. Empty if `name` was never mounted (never throws). */
    versionsOf(name: string): readonly MountedPackage[];
    /** Every mounted package across every name and version, sorted deterministically by name then version so callers never depend on `Map` insertion order (see `@xo/package-sdk`'s `compareSemVer` for the version ordering). */
    all(): readonly MountedPackage[];
    get packageCount(): number;
    get mountCount(): number;
}
//# sourceMappingURL=mounted-package.d.ts.map