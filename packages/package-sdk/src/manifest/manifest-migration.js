import { err, ok } from '@xo/types';
import { ErrorCode, PackageError } from '@xo/errors';
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
    steps = new Map();
    register(migration) {
        this.steps.set(migration.from, migration);
    }
    /** Applies registered steps in sequence starting from `raw.formatVersion` until `targetVersion` is reached. Fails if no path exists (a gap in the registered chain) rather than silently stopping partway. */
    migrate(raw, targetVersion) {
        let current = raw;
        let currentVersion = String(raw.formatVersion ?? '');
        const visited = new Set();
        while (currentVersion !== targetVersion) {
            if (visited.has(currentVersion)) {
                return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, `Migration cycle detected at formatVersion "${currentVersion}"`));
            }
            visited.add(currentVersion);
            const step = this.steps.get(currentVersion);
            if (!step) {
                return err(new PackageError(ErrorCode.PACKAGE_MANIFEST_INVALID, `No registered migration from formatVersion "${currentVersion}" toward "${targetVersion}"`));
            }
            current = { ...step.migrate(current), formatVersion: step.to };
            currentVersion = step.to;
        }
        return ok(current);
    }
}
//# sourceMappingURL=manifest-migration.js.map