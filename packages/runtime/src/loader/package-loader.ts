import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { fingerprintManifest, type InstalledPackageRecord, type PackageInstaller } from '@xo/package-sdk';
import { resolveManifestCapabilityPermissions } from '@xo/permissions';
import type { Logger } from '@xo/logger';
import { NoopLogger } from '@xo/logger';
import type { CapabilityDescriptor } from '../capability/capability-descriptor.js';
import { MountId } from '../ids.js';
import type { MountedPackage } from '../registry/mounted-package.js';
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
export class PackageLoader {
  private readonly now: () => Date;
  private readonly logger: Logger;
  private readonly instrumentation: RuntimeInstrumentation | undefined;

  constructor(
    private readonly installer: PackageInstaller,
    options: PackageLoaderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? new NoopLogger();
    this.instrumentation = options.instrumentation;
  }

  /** Every installed package version on disk, across every package name — including non-active versions (SPECIFICATION.md's "support multiple versions simultaneously"). Discovery alone; nothing is mounted yet. */
  async discover(): Promise<readonly InstalledPackageRecord[]> {
    return this.installer.listAllInstalledRecords();
  }

  /**
   * Verifies (signatures, Merkle tree, per-file hashes, structural
   * manifest/capability consistency — all via `PackageInstaller`'s
   * `verifyInstallation`) and mounts `name@version` into `registry`,
   * returning a *new* registry. Rejects an already-mounted
   * `name@version` (use {@link reload} to remount) and any package that
   * fails verification. Capabilities are read verbatim from
   * `manifest.capabilities` — never inferred from `metadata.json`.
   */
  async mount(name: string, version: string, registry: PackageRegistry): Promise<Result<PackageRegistry, RuntimeError>> {
    if (registry.has(name, version)) {
      return err(new RuntimeError(ErrorCode.RUNTIME_ALREADY_MOUNTED, `"${name}@${version}" is already mounted`));
    }

    const mountStartedAt = this.now().getTime();

    const verification = await this.installer.verifyInstallation(name, version);
    if (!verification.ok) {
      this.instrumentation?.recordVerificationFailure({ package: name, version, reason: verification.error.code });
      return err(new RuntimeError(ErrorCode.RUNTIME_MOUNT_FAILED, `Cannot mount "${name}@${version}": ${verification.error.message}`, { cause: verification.error }));
    }
    if (!verification.value.valid) {
      this.instrumentation?.recordVerificationFailure({ package: name, version, reason: 'validation_report_invalid' });
      const summary = verification.value.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message)
        .join('; ');
      return err(new RuntimeError(ErrorCode.RUNTIME_MOUNT_FAILED, `Refusing to mount "${name}@${version}": failed verification: ${summary}`));
    }

    const manifestResult = await this.installer.getManifest(name, version);
    if (!manifestResult.ok) {
      return err(new RuntimeError(ErrorCode.RUNTIME_MOUNT_FAILED, `Cannot mount "${name}@${version}": ${manifestResult.error.message}`, { cause: manifestResult.error }));
    }
    const manifest = manifestResult.value;

    // Fail fast on a malformed manifest permission declaration (Stage 2
    // §4/§5) — reject the mount entirely rather than letting a broken
    // declaration surface later as a confusing per-execution denial (or,
    // worse, be silently skipped and treated as "no requirements").
    // Reuses `@xo/permissions`' own manifest parser — no duplicated
    // parsing logic — and mirrors the "Refusing to mount" wording already
    // used for a failed structural/signature verification a few lines
    // above.
    const permissionValidation = resolveManifestCapabilityPermissions(manifest);
    if (!permissionValidation.ok) {
      return err(new RuntimeError(ErrorCode.RUNTIME_MOUNT_FAILED, `Refusing to mount "${name}@${version}": malformed permission declaration(s) in manifest: ${permissionValidation.error.join('; ')}`));
    }
    
    const capabilities: readonly CapabilityDescriptor[] = (manifest.capabilities ?? []).map((declaration) => ({
      declaration,
      packageName: name,
      packageVersion: version,
    }));

    const mountedAt = this.now();
    const mounted: MountedPackage = Object.freeze({
      mountId: MountId(`${name}@${version}#${mountedAt.getTime()}`),
      name,
      version,
      manifest,
      capabilities,
      mountedAt: mountedAt.toISOString(),
      manifestHash: fingerprintManifest(manifest),
    });

    const durationMs = this.now().getTime() - mountStartedAt;
    this.instrumentation?.recordMount(durationMs, { package: name, version });
    this.logger.info('mounted package', { package: name, version, capabilityCount: capabilities.length, durationMs });

    const next = registry.withMounted(mounted);
    this.instrumentation?.recordCounts(next.packageCount, componentCount(next));
    return ok(next);
  }

  /** Unmounts `name@version` from `registry`, returning a new registry. Rejects a `name@version` that isn't currently mounted. */
  unmount(name: string, version: string, registry: PackageRegistry): Result<PackageRegistry, RuntimeError> {
    if (!registry.has(name, version)) {
      return err(new RuntimeError(ErrorCode.RUNTIME_NOT_MOUNTED, `"${name}@${version}" is not mounted`));
    }
    const next = registry.withoutMounted(name, version);
    this.logger.info('unmounted package', { package: name, version });
    this.instrumentation?.recordCounts(next.packageCount, componentCount(next));
    return ok(next);
  }

  /** Unmounts (if currently mounted) and re-mounts `name@version` from scratch — a fresh verification pass and a new `mountId`, not a patch of the existing `MountedPackage`. */
  async reload(name: string, version: string, registry: PackageRegistry): Promise<Result<PackageRegistry, RuntimeError>> {
    const base = registry.has(name, version) ? registry.withoutMounted(name, version) : registry;
    return this.mount(name, version, base);
  }

  /**
   * Discovers and mounts every installed package version. Failures are
   * collected rather than aborting the whole pass — one corrupted
   * package shouldn't prevent every other valid package from mounting,
   * matching the "operating system loading applications" analogy: one
   * app failing to launch doesn't halt the OS.
   */
  async mountAllDiscovered(registry: PackageRegistry): Promise<MountAllResult> {
    const records = await this.discover();
    let current = registry;
    const failures: MountFailure[] = [];
    for (const record of records) {
      const result = await this.mount(record.name, record.version, current);
      if (result.ok) current = result.value;
      else failures.push({ name: record.name, version: record.version, error: result.error });
    }
    return { registry: current, failures };
  }
}

function componentCount(registry: PackageRegistry): number {
  return registry.all().reduce((total, pkg) => total + Object.keys(pkg.manifest.components).length, 0);
}
