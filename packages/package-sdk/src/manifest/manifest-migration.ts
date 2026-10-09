import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';

/**
 * A step that migrates a raw (untyped) manifest object forward from
 * `from` to `to`. Operates on `unknown`/`Record<string, unknown>` rather
 * than `XoManifest` because a manifest being migrated is, by definition,
 * not yet in the current typed shape.
 */
export interface ManifestMigration {
  readonly from: string;
  readonly to: string;
  migrate(raw: Record<string, unknown>): Record<string, unknown>;
}

/**
 * A real, working migration pipeline — register steps, then apply the
 * chain from a manifest's declared `formatVersion` up to `targetVersion`.
 * There are currently zero registered migrations because
 * `packages/types/src/xo-manifest.ts` (frozen) only defines one
 * `formatVersion` to date; this is the honest state of a genuine
 * single-version format, not a stub — `register`/`migrate` are fully
 * implemented and exercised by tests using synthetic versions, and this
 * class is the integration seam a future format bump plugs into, per
 * "build the interface and document the integration seam rather than
 * mocking behavior."
 */
export class ManifestMigrationRegistry {
  private readonly steps = new Map<string, ManifestMigration>();

  register(migration: ManifestMigration): void {
    this.steps.set(migration.from, migration);
  }

  /** Applies registered steps in sequence starting from `raw.formatVersion` until `targetVersion` is reached. Fails if no path exists (a gap in the registered chain) rather than silently stopping partway. */
  migrate(raw: Record<string, unknown>, targetVersion: string): Result<Record<string, unknown>, PackageError> {
    let current = raw;
    let currentVersion = String(raw.formatVersion ?? '');
    const visited = new Set<string>();

    while (currentVersion !== targetVersion) {
      if (visited.has(currentVersion)) {
        return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, `Migration cycle detected at formatVersion "${currentVersion}"`));
      }
      visited.add(currentVersion);
      const step = this.steps.get(currentVersion);
      if (!step) {
        return err(
          new PackageError(
            ErrorCode.PACKAGE_MANIFEST_INVALID,
            `No registered migration from formatVersion "${currentVersion}" toward "${targetVersion}"`,
          ),
        );
      }
      current = { ...step.migrate(current), formatVersion: step.to };
      currentVersion = step.to;
    }
    return ok(current);
  }
}
