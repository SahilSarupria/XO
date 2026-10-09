import type { ComponentKind } from '@xo/types';
import type { BlobStore } from '@xo/storage';
import { type Result } from '@xo/types';
import { InstallError, PackageError, StorageError } from '@xo/errors';
import { PackageValidator } from '../validation/package-validator.js';
import type { InstalledPackageRecord, PackageBundle, ValidationReport } from '../types.js';
import { Clock } from './clock.js';
export interface InstallOptions {
    /** Reinstall over an existing install at the same version instead of failing with PACKAGE_ALREADY_INSTALLED. */
    readonly force?: boolean;
    /** Skip PackageValidator.validateAll before writing. Off by default — installing an unvalidated bundle is opt-in, never the default. */
    readonly skipValidation?: boolean;
}
/**
 * Installs, removes, upgrades, and inspects XO packages against an
 * injected {@link BlobStore}. This is local install-state management only
 * — fetching a package *from* a marketplace/registry is explicitly out of
 * scope ("Support future registry integration but DO NOT implement the
 * registry"); callers are expected to already have a validated
 * {@link PackageBundle} (e.g. from `unpackArchive`) in hand.
 */
export declare class PackageInstaller {
    private readonly store;
    private readonly validator;
    private readonly clock;
    constructor(store: BlobStore, options?: {
        readonly validator?: PackageValidator;
        readonly clock?: Clock;
    });
    private readIndex;
    private writeIndex;
    install(bundle: PackageBundle, options?: InstallOptions): Promise<Result<InstalledPackageRecord, InstallError | PackageError>>;
    uninstall(name: string, version: string): Promise<Result<void, InstallError>>;
    /**
     * Installs `bundle` as a new version of an already-installed package,
     * refusing (`PACKAGE_UPGRADE_INVALID`) unless its version is strictly
     * greater than the currently active one. The prior version's files are
     * left in place rather than deleted, so {@link rollback} can re-point
     * the active version back to it without a reinstall.
     */
    upgrade(bundle: PackageBundle, options?: InstallOptions): Promise<Result<InstalledPackageRecord, InstallError | PackageError>>;
    /** Re-points the active version pointer to an already-installed (but no longer active) version — the rollback counterpart to {@link upgrade}. Fails if that version's files were previously removed via `uninstall`. */
    rollback(name: string, toVersion: string): Promise<Result<void, InstallError>>;
    /**
     * Every installed record for `name`, across all installed versions —
     * unlike {@link listInstalled}, which returns only each package's
     * single currently-*active* version. `@xo/runtime`'s package loader
     * needs this: Runtime Stage 1 mounts whatever versions are actually on
     * disk (SPECIFICATION.md's "support multiple versions simultaneously"),
     * independent of which one this SDK's own active-version pointer
     * happens to point at.
     */
    listAllInstalledRecords(): Promise<readonly InstalledPackageRecord[]>;
    /**
     * Reads and structurally validates the manifest for a specific
     * installed `name@version` — including non-active versions, unlike
     * {@link verifyInstallation} (which re-hashes everything but doesn't
     * return the manifest) or any bundle-shaped method (which requires
     * component bytes the caller may not need just to mount a package).
     */
    getManifest(name: string, version: string): Promise<Result<PackageBundle['manifest'], InstallError | PackageError>>;
    /**
     * Reads one component's raw bytes for a specific installed version —
     * `@xo/runtime`'s knowledge retrieval (Stage 2) needs actual component
     * content (e.g. a `knowledge_graph`'s JSON), not just the manifest's
     * path/hash record of it. Not hash-verified here; call
     * {@link verifyInstallation} first if that matters for the caller —
     * this method optimizes for the common "already-mounted, already
     * verified, now fetch content" path without paying a re-hash per
     * component read.
     */
    getComponent(name: string, version: string, kind: ComponentKind): Promise<Result<Uint8Array, InstallError | PackageError>>;
    listInstalled(): Promise<readonly InstalledPackageRecord[]>;
    /** Re-hashes every installed file for `name@version` against its recorded manifest — detects on-disk corruption or tampering after install, distinct from `PackageValidator` validating a bundle before install. */
    verifyInstallation(name: string, version: string): Promise<Result<ValidationReport, InstallError>>;
    /**
     * Reinstalls `name@version` from `sourceBundle` — a caller-supplied
     * known-good copy (e.g. re-fetched from wherever the original archive
     * came from), since this SDK has no registry integration to fetch a
     * replacement from itself. Intended to follow a failed
     * `verifyInstallation()`.
     */
    repairInstallation(sourceBundle: PackageBundle): Promise<Result<InstalledPackageRecord, InstallError | PackageError>>;
}
export type { StorageError };
//# sourceMappingURL=package-installer.d.ts.map