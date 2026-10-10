import type { ComponentKind } from '@xo/types';
import type { BlobStore } from '@xo/storage';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, InstallError, PackageError, StorageError } from '@xo/errors';
import { fingerprintManifest } from '../hashing/fingerprint.js';
import { classifyBump } from '../manifest/semver.js';
import { PackageValidator } from '../validation/package-validator.js';
import { componentCollisionProblem, componentPathProblem, confinementProblem, packageSegmentProblem } from '../validation/safe-path.js';
import { isXoManifest } from '../validation/schema.js';
import type { InstalledPackageRecord, PackageBundle, ValidationReport } from '../types.js';
import { Clock, SystemClock } from './clock.js';

const INDEX_KEY = '_index.json';

interface InstallIndex {
  readonly active: Readonly<Record<string, string>>; // package name -> active version
}

function packagePrefix(name: string, version: string): string {
  return `${name}/${version}`;
}

function recordKey(name: string, version: string): string {
  return `_records/${name}@${version}.json`;
}

/**
 * Path-confinement gate for {@link PackageInstaller.install}. Returns a
 * description of the first unsafe name/version/component path, or
 * `undefined` if everything stays inside `<name>/<version>/`.
 *
 * This deliberately lives in the installer — not only in
 * `PackageValidator` — because `skipValidation` bypasses the validator
 * but must never bypass confinement: it is a security boundary, not a
 * quality check. It inspects both the manifest's declared component paths
 * and the bundle's own component paths (the ones actually written), and
 * runs before any `store` call so a rejected package causes zero writes.
 */
function findUnsafeInstallLocation(bundle: PackageBundle): string | undefined {
  const { name, version } = bundle.manifest;
  const identityProblem = packageSegmentProblem('name', name) ?? packageSegmentProblem('version', version);
  if (identityProblem) return identityProblem;

  const prefix = packagePrefix(name, version);
  const paths = [...Object.values(bundle.manifest.components).map((e) => e.path), ...bundle.components.map((c) => c.path)];
  for (const path of paths) {
    const problem = componentPathProblem(path) ?? confinementProblem(prefix, path);
    if (problem) return problem;
  }
  return componentCollisionProblem(bundle.components.map((c) => c.path));
}

/**
 * Identity gate for the methods that take a caller-supplied `name`/`version`
 * (some of which arrive straight from HTTP request parameters). A package
 * with an unsafe name or version can never have been installed — `install()`
 * refuses it — so these methods answer exactly as for any other package that
 * is not installed, rather than letting `a/../other` alias another package's
 * directory.
 */
function notInstalledIfUnsafe(name: string, version: string): InstallError | undefined {
  return (packageSegmentProblem('name', name) ?? packageSegmentProblem('version', version))
    ? new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`)
    : undefined;
}

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
export class PackageInstaller {
  private readonly validator: PackageValidator;
  private readonly clock: Clock;

  constructor(
    private readonly store: BlobStore,
    options: { readonly validator?: PackageValidator; readonly clock?: Clock } = {},
  ) {
    this.validator = options.validator ?? new PackageValidator();
    this.clock = options.clock ?? new SystemClock();
  }

  private async readIndex(): Promise<InstallIndex> {
    const raw = await this.store.get(INDEX_KEY);
    if (!raw.ok) return { active: {} };
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as InstallIndex;
    } catch {
      return { active: {} };
    }
  }

  private async writeIndex(index: InstallIndex): Promise<void> {
    await this.store.put(INDEX_KEY, JSON.stringify(index, null, 2), { contentType: 'application/json' });
  }

  async install(bundle: PackageBundle, options: InstallOptions = {}): Promise<Result<InstalledPackageRecord, InstallError | PackageError>> {
    const { name, version } = bundle.manifest;

    // Confinement first, unconditionally (even with skipValidation), and before any store access.
    const unsafe = findUnsafeInstallLocation(bundle);
    if (unsafe) {
      return err(new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Refusing to install package: unsafe install location — ${unsafe}`));
    }

    if (!options.skipValidation) {
      const report = this.validator.validateAll(bundle);
      if (!report.valid) {
        return err(new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Refusing to install "${name}@${version}": ${report.issues.filter((i) => i.severity === 'error').map((i) => i.message).join('; ')}`));
      }
    }

    const alreadyInstalled = await this.store.has(recordKey(name, version));
    if (alreadyInstalled && !options.force) {
      return err(new InstallError(ErrorCode.PACKAGE_ALREADY_INSTALLED, `"${name}@${version}" is already installed`));
    }

    const prefix = packagePrefix(name, version);
    const putResults = await Promise.all([
      this.store.put(`${prefix}/manifest.json`, JSON.stringify(bundle.manifest, null, 2), { contentType: 'application/json' }),
      this.store.put(`${prefix}/metadata.json`, bundle.ancillary.metadataJson, { contentType: 'application/json' }),
      ...bundle.components.map((c) => this.store.put(`${prefix}/${c.path}`, c.data)),
    ]);
    const failed = putResults.find((r) => !r.ok);
    if (failed && !failed.ok) {
      return err(new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Failed to write component(s) for "${name}@${version}"`, { cause: failed.error }));
    }

    const record: InstalledPackageRecord = {
      name,
      version,
      installedAt: this.clock.now().toISOString(),
      manifestHash: fingerprintManifest(bundle.manifest),
      componentPaths: bundle.components.map((c) => `${prefix}/${c.path}`),
    };
    await this.store.put(recordKey(name, version), JSON.stringify(record, null, 2), { contentType: 'application/json' });

    const index = await this.readIndex();
    await this.writeIndex({ active: { ...index.active, [name]: version } });

    return ok(record);
  }

  async uninstall(name: string, version: string): Promise<Result<void, InstallError>> {
    const unsafeIdentity = notInstalledIfUnsafe(name, version);
    if (unsafeIdentity) return err(unsafeIdentity);
    const key = recordKey(name, version);
    const recordRaw = await this.store.get(key);
    if (!recordRaw.ok) {
      return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`));
    }
    const record = JSON.parse(new TextDecoder().decode(recordRaw.value)) as InstalledPackageRecord;

    // Fail closed before deleting anything: a record written by a pre-fix install can list paths that point into another package's directory.
    const prefix = packagePrefix(name, version);
    const outside = record.componentPaths.find(
      (path) => !path.startsWith(`${prefix}/`) || confinementProblem(prefix, path.slice(prefix.length + 1)) !== undefined,
    );
    if (outside !== undefined) {
      return err(
        new InstallError(
          ErrorCode.PACKAGE_VALIDATION_FAILED,
          `Refusing to uninstall "${name}@${version}": its install record lists "${outside}", which is outside "${prefix}/". Nothing was deleted.`,
        ),
      );
    }

    for (const path of record.componentPaths) await this.store.delete(path);
    await this.store.delete(`${packagePrefix(name, version)}/manifest.json`);
    await this.store.delete(`${packagePrefix(name, version)}/metadata.json`);
    await this.store.delete(key);

    const index = await this.readIndex();
    if (index.active[name] === version) {
      const { [name]: _removed, ...rest } = index.active;
      await this.writeIndex({ active: rest });
    }
    return ok(undefined);
  }

  /**
   * Installs `bundle` as a new version of an already-installed package,
   * refusing (`PACKAGE_UPGRADE_INVALID`) unless its version is strictly
   * greater than the currently active one. The prior version's files are
   * left in place rather than deleted, so {@link rollback} can re-point
   * the active version back to it without a reinstall.
   */
  async upgrade(bundle: PackageBundle, options: InstallOptions = {}): Promise<Result<InstalledPackageRecord, InstallError | PackageError>> {
    const { name, version } = bundle.manifest;
    const index = await this.readIndex();
    const currentVersion = index.active[name];
    if (!currentVersion) {
      return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `Cannot upgrade "${name}": no version is currently installed`));
    }
    const bump = classifyBump(currentVersion, version);
    if (bump === 'invalid' || bump === 'none') {
      return err(new InstallError(ErrorCode.PACKAGE_UPGRADE_INVALID, `"${version}" is not a valid upgrade from the installed "${currentVersion}"`));
    }
    return this.install(bundle, { ...options, force: true });
  }

  /** Re-points the active version pointer to an already-installed (but no longer active) version — the rollback counterpart to {@link upgrade}. Fails if that version's files were previously removed via `uninstall`. */
  async rollback(name: string, toVersion: string): Promise<Result<void, InstallError>> {
    const unsafeIdentity = notInstalledIfUnsafe(name, toVersion);
    if (unsafeIdentity) return err(unsafeIdentity);
    const has = await this.store.has(recordKey(name, toVersion));
    if (!has) {
      return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `Cannot roll back "${name}" to "${toVersion}": that version's files are not present (was it uninstalled?)`));
    }
    const index = await this.readIndex();
    await this.writeIndex({ active: { ...index.active, [name]: toVersion } });
    return ok(undefined);
  }

  /**
   * Every installed record for `name`, across all installed versions —
   * unlike {@link listInstalled}, which returns only each package's
   * single currently-*active* version. `@xo/runtime`'s package loader
   * needs this: Runtime Stage 1 mounts whatever versions are actually on
   * disk (SPECIFICATION.md's "support multiple versions simultaneously"),
   * independent of which one this SDK's own active-version pointer
   * happens to point at.
   */
  async listAllInstalledRecords(): Promise<readonly InstalledPackageRecord[]> {
    const keys = await this.store.list('_records/');
    if (!keys.ok) return [];
    const records: InstalledPackageRecord[] = [];
    for (const key of keys.value) {
      const raw = await this.store.get(key);
      if (raw.ok) records.push(JSON.parse(new TextDecoder().decode(raw.value)) as InstalledPackageRecord);
    }
    return records;
  }

  /**
   * Reads and structurally validates the manifest for a specific
   * installed `name@version` — including non-active versions, unlike
   * {@link verifyInstallation} (which re-hashes everything but doesn't
   * return the manifest) or any bundle-shaped method (which requires
   * component bytes the caller may not need just to mount a package).
   */
  async getManifest(name: string, version: string): Promise<Result<PackageBundle['manifest'], InstallError | PackageError>> {
    const unsafeIdentity = notInstalledIfUnsafe(name, version);
    if (unsafeIdentity) return err(unsafeIdentity);
    const raw = await this.store.get(`${packagePrefix(name, version)}/manifest.json`);
    if (!raw.ok) {
      return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw.value));
    } catch (cause) {
      return err(new PackageError(ErrorCode.PACKAGE_CORRUPT, `Installed manifest for "${name}@${version}" is not valid JSON`, { cause }));
    }
    if (!isXoManifest(parsed)) {
      return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, `Installed manifest for "${name}@${version}" does not match the XoManifest shape`));
    }
    return ok(parsed);
  }

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
  async getComponent(name: string, version: string, kind: ComponentKind): Promise<Result<Uint8Array, InstallError | PackageError>> {
    const manifestResult = await this.getManifest(name, version);
    if (!manifestResult.ok) return manifestResult;

    const entry = manifestResult.value.components[kind];
    if (!entry) {
      return err(new PackageError(ErrorCode.PACKAGE_COMPONENT_MISSING, `"${name}@${version}" does not declare a "${kind}" component`));
    }

    const raw = await this.store.get(`${packagePrefix(name, version)}/${entry.path}`);
    if (!raw.ok) {
      return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}"'s "${kind}" component is not present in storage`));
    }
    return ok(raw.value);
  }

  async listInstalled(): Promise<readonly InstalledPackageRecord[]> {
    const index = await this.readIndex();
    const records: InstalledPackageRecord[] = [];
    for (const [name, version] of Object.entries(index.active)) {
      const raw = await this.store.get(recordKey(name, version));
      if (raw.ok) records.push(JSON.parse(new TextDecoder().decode(raw.value)) as InstalledPackageRecord);
    }
    return records;
  }

  /** Re-hashes every installed file for `name@version` against its recorded manifest — detects on-disk corruption or tampering after install, distinct from `PackageValidator` validating a bundle before install. */
  async verifyInstallation(name: string, version: string): Promise<Result<ValidationReport, InstallError>> {
    const unsafeIdentity = notInstalledIfUnsafe(name, version);
    if (unsafeIdentity) return err(unsafeIdentity);
    const manifestRaw = await this.store.get(`${packagePrefix(name, version)}/manifest.json`);
    if (!manifestRaw.ok) {
      return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`));
    }
    const manifest = JSON.parse(new TextDecoder().decode(manifestRaw.value)) as PackageBundle['manifest'];

    const metadataRaw = await this.store.get(`${packagePrefix(name, version)}/metadata.json`);
    const issues: ValidationReport['issues'][number][] = [];
    const components: PackageBundle['components'][number][] = [];
    for (const [kind, entry] of Object.entries(manifest.components)) {
      const data = await this.store.get(`${packagePrefix(name, version)}/${entry.path}`);
      if (!data.ok) {
        if (entry.required) issues.push({ severity: 'error', code: 'INSTALLED_COMPONENT_MISSING', message: `"${entry.path}" is missing from the install`, path: entry.path });
        continue;
      }
      components.push({ kind: kind as PackageBundle['components'][number]['kind'], path: entry.path, data: data.value, required: entry.required });
    }

    const bundle: PackageBundle = {
      manifest,
      components,
      ancillary: { metadataJson: metadataRaw.ok ? metadataRaw.value : new Uint8Array() },
    };
    const report = this.validator.validateAll(bundle);
    return ok({ valid: report.valid && issues.length === 0, issues: [...issues, ...report.issues] });
  }

  /**
   * Reinstalls `name@version` from `sourceBundle` — a caller-supplied
   * known-good copy (e.g. re-fetched from wherever the original archive
   * came from), since this SDK has no registry integration to fetch a
   * replacement from itself. Intended to follow a failed
   * `verifyInstallation()`.
   */
  async repairInstallation(sourceBundle: PackageBundle): Promise<Result<InstalledPackageRecord, InstallError | PackageError>> {
    return this.install(sourceBundle, { force: true });
  }
}

// Re-exported so callers constructing a StorageError-backed Result from
// their own BlobStore implementation don't need a second import for it.
export type { StorageError };
