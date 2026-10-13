import type { ComponentKind, XoManifest } from '@xo/types';
import type { BlobStore } from '@xo/storage';
import { err, ok, type Result } from '@xo/types';
import type { StorageError } from '@xo/errors';
import { ErrorCode, InstallError, PackageError } from '@xo/errors';
import { Sha256Hasher } from '@xo/crypto';
import { canonicalJson, fingerprintManifest } from '../hashing/fingerprint.js';
import { hashComponent } from '../hashing/component-hasher.js';
import { classifyBump } from '../manifest/semver.js';
import { PackageValidator } from '../validation/package-validator.js';
import { componentCollisionProblem, componentPathProblem, confinementProblem, packageSegmentProblem } from '../validation/safe-path.js';
import { isXoManifest } from '../validation/schema.js';
import type { InstalledPackageRecord, PackageBundle, ValidationReport } from '../types.js';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';

const INDEX_KEY = '_index.json';

/** Digest of the entire manifest *including* signatures (unlike `fingerprintManifest`, which excludes them) — recorded at install so signature stripping/swapping on disk is detectable. */
function fullManifestDigest(manifest: XoManifest): string {
  return new Sha256Hasher().hash(new TextEncoder().encode(canonicalJson(manifest)));
}

/** Deep-copies the bundle so verification and writing see the same, caller-immutable bytes. */
function pinBundle(input: PackageBundle): PackageBundle {
  return {
    manifest: JSON.parse(JSON.stringify(input.manifest)) as XoManifest,
    components: input.components.map((c) => ({ ...c, data: new Uint8Array(c.data) })),
    ancillary: {
      metadataJson: new Uint8Array(input.ancillary.metadataJson),
      ...(input.ancillary.changelogMd !== undefined ? { changelogMd: new Uint8Array(input.ancillary.changelogMd) } : {}),
    },
  };
}

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

  /**
   * Installs a bundle.
   *
   * M5 guarantees: the bundle is first copied (verification and writing operate on the same pinned bytes, so a caller mutating its buffers afterwards cannot make "what was verified" differ from "what was written"); path confinement and — when the trust policy enforces — signature trust are checked unconditionally (`skipValidation` never bypasses either); every written file is read back and re-verified before the install record exists; and any failure restores the previous state (previous valid install bytes, or nothing) so no partially written, loadable package is left behind.
   */
  async install(input: PackageBundle, options: InstallOptions = {}): Promise<Result<InstalledPackageRecord, InstallError | PackageError>> {
    const bundle = pinBundle(input);
    const { name, version } = bundle.manifest;

    // Confinement first, unconditionally (even with skipValidation), and before any store access.
    const unsafe = findUnsafeInstallLocation(bundle);
    if (unsafe) {
      return err(new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Refusing to install package: unsafe install location — ${unsafe}`));
    }

    // Trust, unconditionally when the operator policy enforces (also with skipValidation).
    const verdict = this.validator.evaluateTrust(bundle.manifest);
    if (!verdict.acceptable) {
      return err(
        new InstallError(
          ErrorCode.PACKAGE_UNTRUSTED,
          `Refusing to install "${name}@${version}": package trust check failed: ${verdict.failures.map((f) => `${f.code}: ${f.message}`).join('; ')}`,
        ),
      );
    }

    if (!options.skipValidation) {
      const report = this.validator.validateAll(bundle);
      if (!report.valid) {
        return err(
          new InstallError(
            ErrorCode.PACKAGE_VALIDATION_FAILED,
            `Refusing to install "${name}@${version}": ${report.issues
              .filter((i) => i.severity === 'error')
              .map((i) => i.message)
              .join('; ')}`,
          ),
        );
      }
    }

    const alreadyInstalled = await this.store.has(recordKey(name, version));
    if (alreadyInstalled && !options.force) {
      return err(new InstallError(ErrorCode.PACKAGE_ALREADY_INSTALLED, `"${name}@${version}" is already installed`));
    }

    const prefix = packagePrefix(name, version);
    const writes: { readonly key: string; readonly data: Uint8Array | string; readonly contentType?: string }[] = [
      { key: `${prefix}/manifest.json`, data: JSON.stringify(bundle.manifest, null, 2), contentType: 'application/json' },
      { key: `${prefix}/metadata.json`, data: bundle.ancillary.metadataJson, contentType: 'application/json' },
      ...bundle.components.map((c) => ({ key: `${prefix}/${c.path}`, data: c.data })),
    ];
    const recordKeyName = recordKey(name, version);
    const touched = [...writes.map((w) => w.key), recordKeyName];

    // Snapshot whatever is there now so a failed (re)install restores it instead of leaving a mixture.
    const backup = new Map<string, Uint8Array | undefined>();
    for (const key of touched) {
      const existing = await this.store.get(key);
      backup.set(key, existing.ok ? existing.value : undefined);
    }
    const restore = async (): Promise<void> => {
      for (const key of touched) {
        const prior = backup.get(key);
        if (prior === undefined) await this.store.delete(key);
        else await this.store.put(key, prior);
      }
    };

    // Until the record is written the package is "not installed"; a forced reinstall removes the old record first so a crash mid-write can never leave an old record vouching for new, half-written bytes.
    if (alreadyInstalled) await this.store.delete(recordKeyName);

    const putResults = await Promise.all(
      writes.map((w) => this.store.put(w.key, w.data, w.contentType !== undefined ? { contentType: w.contentType } : undefined)),
    );
    const failed = putResults.find((r) => !r.ok);
    if (failed && !failed.ok) {
      await restore();
      return err(
        new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Failed to write component(s) for "${name}@${version}"`, {
          cause: failed.error,
        }),
      );
    }

    // Read-back verification: what is on disk is what was verified. Skipped only when the caller explicitly opted out of validation.
    if (!options.skipValidation) {
      const readBack = await this.verifyAndLoad(name, version);
      if (!readBack.ok || !readBack.value.report.valid) {
        await restore();
        const detail = readBack.ok
          ? readBack.value.report.issues
              .filter((i) => i.severity === 'error')
              .map((i) => i.message)
              .join('; ')
          : readBack.error.message;
        return err(
          new InstallError(
            ErrorCode.PACKAGE_VALIDATION_FAILED,
            `Installed bytes for "${name}@${version}" failed read-back verification: ${detail}`,
          ),
        );
      }
    }

    const record: InstalledPackageRecord = {
      name,
      version,
      installedAt: this.clock.now().toISOString(),
      manifestHash: fingerprintManifest(bundle.manifest),
      manifestDigest: fullManifestDigest(bundle.manifest),
      trust: { status: verdict.status, policyId: verdict.policyId, signers: verdict.signers },
      componentPaths: bundle.components.map((c) => `${prefix}/${c.path}`),
    };
    const recordPut = await this.store.put(recordKeyName, JSON.stringify(record, null, 2), { contentType: 'application/json' });
    if (!recordPut.ok) {
      await restore();
      return err(
        new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `Failed to write install record for "${name}@${version}"`, {
          cause: recordPut.error,
        }),
      );
    }

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
      return err(
        new InstallError(ErrorCode.PACKAGE_UPGRADE_INVALID, `"${version}" is not a valid upgrade from the installed "${currentVersion}"`),
      );
    }
    return this.install(bundle, { ...options, force: true });
  }

  /** Re-points the active version pointer to an already-installed (but no longer active) version — the rollback counterpart to {@link upgrade}. Fails if that version's files were previously removed via `uninstall`. */
  async rollback(name: string, toVersion: string): Promise<Result<void, InstallError>> {
    const unsafeIdentity = notInstalledIfUnsafe(name, toVersion);
    if (unsafeIdentity) return err(unsafeIdentity);
    const has = await this.store.has(recordKey(name, toVersion));
    if (!has) {
      return err(
        new InstallError(
          ErrorCode.PACKAGE_NOT_INSTALLED,
          `Cannot roll back "${name}" to "${toVersion}": that version's files are not present (was it uninstalled?)`,
        ),
      );
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
      return err(
        new PackageError(
          ErrorCode.PACKAGE_MANIFEST_INVALID,
          `Installed manifest for "${name}@${version}" does not match the XoManifest shape`,
        ),
      );
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
    // Re-checked on every read: components are read long after mount, so a verification done once at mount must not authorise different bytes later.
    if (hashComponent({ kind, path: entry.path, data: raw.value, required: entry.required }) !== entry.hash) {
      return err(
        new PackageError(
          ErrorCode.PACKAGE_CORRUPT,
          `"${name}@${version}"'s "${kind}" component does not match its manifest hash (modified after install?)`,
        ),
      );
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

  /** Re-hashes every installed file for `name@version` against its recorded manifest and re-evaluates trust under the *current* operator policy — detects on-disk corruption, tampering, a swapped manifest, or a since-revoked signing key; distinct from `PackageValidator` validating a bundle before install. */
  async verifyInstallation(name: string, version: string): Promise<Result<ValidationReport, InstallError>> {
    const loaded = await this.verifyAndLoad(name, version);
    return loaded.ok ? ok(loaded.value.report) : loaded;
  }

  /**
   * Verifies the installed package and returns the very manifest that was verified, from one read. Callers that go on to use the manifest (the runtime loader) MUST use this rather than calling `verifyInstallation` and then re-reading `getManifest`, which would let the bytes change between the check and the use.
   */
  async loadVerified(
    name: string,
    version: string,
  ): Promise<Result<{ readonly manifest: XoManifest; readonly report: ValidationReport }, InstallError>> {
    return this.verifyAndLoad(name, version);
  }

  private async verifyAndLoad(
    name: string,
    version: string,
  ): Promise<Result<{ readonly manifest: XoManifest; readonly report: ValidationReport }, InstallError>> {
    const unsafeIdentity = notInstalledIfUnsafe(name, version);
    if (unsafeIdentity) return err(unsafeIdentity);
    const manifestRaw = await this.store.get(`${packagePrefix(name, version)}/manifest.json`);
    if (!manifestRaw.ok) {
      return err(new InstallError(ErrorCode.PACKAGE_NOT_INSTALLED, `"${name}@${version}" is not installed`));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(manifestRaw.value));
    } catch {
      return err(new InstallError(ErrorCode.PACKAGE_VALIDATION_FAILED, `"${name}@${version}" has an unreadable installed manifest`));
    }
    if (!isXoManifest(parsed)) {
      return err(
        new InstallError(
          ErrorCode.PACKAGE_VALIDATION_FAILED,
          `"${name}@${version}" has an installed manifest that does not match the XoManifest schema`,
        ),
      );
    }
    const manifest: XoManifest = parsed;

    const issues: ValidationReport['issues'][number][] = [];
    // Identity: the directory a manifest lives in must be the identity it declares.
    if (manifest.name !== name || manifest.version !== version) {
      issues.push({
        severity: 'error',
        code: 'INSTALLED_IDENTITY_MISMATCH',
        message: `installed manifest declares "${manifest.name}@${manifest.version}" but lives under "${name}@${version}"`,
        path: 'manifest.json',
      });
    }
    // The manifest on disk must be byte-for-byte the manifest (signatures included) that was admitted at install time.
    const recordRaw = await this.store.get(recordKey(name, version));
    if (recordRaw.ok) {
      try {
        const record = JSON.parse(new TextDecoder().decode(recordRaw.value)) as InstalledPackageRecord;
        if (record.manifestDigest !== undefined && record.manifestDigest !== fullManifestDigest(manifest)) {
          issues.push({
            severity: 'error',
            code: 'INSTALLED_MANIFEST_CHANGED',
            message: 'the installed manifest (or its signatures) differs from the manifest that was admitted at install time',
            path: 'manifest.json',
          });
        }
      } catch {
        issues.push({
          severity: 'error',
          code: 'INSTALLED_RECORD_CORRUPT',
          message: 'the install record is unreadable',
          path: `_records/${name}@${version}.json`,
        });
      }
    }

    const metadataRaw = await this.store.get(`${packagePrefix(name, version)}/metadata.json`);
    const components: PackageBundle['components'][number][] = [];
    for (const [kind, entry] of Object.entries(manifest.components)) {
      const data = await this.store.get(`${packagePrefix(name, version)}/${entry.path}`);
      if (!data.ok) {
        if (entry.required)
          issues.push({
            severity: 'error',
            code: 'INSTALLED_COMPONENT_MISSING',
            message: `"${entry.path}" is missing from the install`,
            path: entry.path,
          });
        continue;
      }
      components.push({
        kind: kind as PackageBundle['components'][number]['kind'],
        path: entry.path,
        data: data.value,
        required: entry.required,
      });
    }

    const bundle: PackageBundle = {
      manifest,
      components,
      ancillary: { metadataJson: metadataRaw.ok ? metadataRaw.value : new Uint8Array() },
    };
    const report = this.validator.validateAll(bundle);
    return ok({ manifest, report: { valid: report.valid && issues.length === 0, issues: [...issues, ...report.issues] } });
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
