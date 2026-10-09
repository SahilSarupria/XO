import { type Result } from '@xo/types';
import { RuntimeError } from '@xo/errors';
import { type InstalledPackageRecord, type PackageInstaller } from '@xo/package-sdk';
import type { Logger } from '@xo/logger';
import { PackageRegistry } from '../registry/mounted-package.js';
import type { RuntimeInstrumentation } from '../observability/instrumentation.js';
export interface PackageLoaderOptions {
    readonly now?: () => Date;
    readonly logger?: Logger;
    readonly instrumentation?: RuntimeInstrumentation;
}
/** One package that failed to mount during a batch `mountAllDiscovered` pass, and why. */
export interface MountFailure {
    readonly name: string;
    readonly version: string;
    readonly error: RuntimeError;
}
export interface MountAllResult {
    readonly registry: PackageRegistry;
    readonly failures: readonly MountFailure[];
}
/**
 * Package Mounting & Execution Pipeline (Runtime Stage 1): discovers
 * installed `.xo` packages, verifies them, and mounts them into a
 * {@link PackageRegistry} as executable capabilities — the "operating
 * system loading applications" analogy the stage is scoped to. Delegates
 * install-state discovery and cryptographic/structural verification
 * entirely to the injected `PackageInstaller` (`@xo/package-sdk`) rather
 * than reimplementing hash/Merkle/signature checking here: mounting is a
 * *new* responsibility layered on top of "is this package's on-disk state
 * valid", not a replacement for it.
 *
 * Every method here is pure with respect to its `PackageRegistry`
 * argument — none of them hold or mutate registry state internally; the
 * caller (typically `Runtime`, see `runtime.ts`) threads an immutable
 * registry through mount/unmount/reload and keeps the latest one.
 */
export declare class PackageLoader {
    private readonly installer;
    private readonly now;
    private readonly logger;
    private readonly instrumentation;
    constructor(installer: PackageInstaller, options?: PackageLoaderOptions);
    /** Every installed package version on disk, across every package name — including non-active versions (SPECIFICATION.md's "support multiple versions simultaneously"). Discovery alone; nothing is mounted yet. */
    discover(): Promise<readonly InstalledPackageRecord[]>;
    /**
     * Verifies (signatures, Merkle tree, per-file hashes, structural
     * manifest/capability consistency — all via `PackageInstaller`'s
     * `verifyInstallation`) and mounts `name@version` into `registry`,
     * returning a *new* registry. Rejects an already-mounted
     * `name@version` (use {@link reload} to remount) and any package that
     * fails verification. Capabilities are read verbatim from
     * `manifest.capabilities` — never inferred from `metadata.json`.
     */
    mount(name: string, version: string, registry: PackageRegistry): Promise<Result<PackageRegistry, RuntimeError>>;
    /** Unmounts `name@version` from `registry`, returning a new registry. Rejects a `name@version` that isn't currently mounted. */
    unmount(name: string, version: string, registry: PackageRegistry): Result<PackageRegistry, RuntimeError>;
    /** Unmounts (if currently mounted) and re-mounts `name@version` from scratch — a fresh verification pass and a new `mountId`, not a patch of the existing `MountedPackage`. */
    reload(name: string, version: string, registry: PackageRegistry): Promise<Result<PackageRegistry, RuntimeError>>;
    /**
     * Discovers and mounts every installed package version. Failures are
     * collected rather than aborting the whole pass — one corrupted
     * package shouldn't prevent every other valid package from mounting,
     * matching the "operating system loading applications" analogy: one
     * app failing to launch doesn't halt the OS.
     */
    mountAllDiscovered(registry: PackageRegistry): Promise<MountAllResult>;
}
//# sourceMappingURL=package-loader.d.ts.map