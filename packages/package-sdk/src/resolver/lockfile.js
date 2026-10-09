import { err, ok } from '@xo/types';
import { ErrorCode, DependencyError } from '@xo/errors';
import { Sha256Hasher } from '@xo/crypto';
import { canonicalJson, fingerprintManifest } from '../hashing/fingerprint.js';
import { satisfiesRange } from '../manifest/semver.js';
/** Bumped independently of `XoManifest.formatVersion` — the lockfile is this SDK's own artifact, not part of the `.xo` package format itself. */
export const LOCKFILE_VERSION = '1';
/**
 * Builds an `xo.lock`-shaped value from a resolver result. Every
 * resolved dependency (direct and transitive alike — `resolveDependencies`
 * already flattened the tree) is recorded with its exact version and a
 * content hash (`fingerprintManifest`, the same manifest fingerprint
 * `comparePackages`/the installer already use to recognize identical
 * package content). Sorted by name so the output is stable regardless of
 * resolution order.
 */
export function createLockfile(resolution, hasher = new Sha256Hasher()) {
    const dependencies = resolution.resolved
        .map((dependency) => ({ name: dependency.name, version: dependency.version, contentHash: fingerprintManifest(dependency.manifest, hasher) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return {
        lockfileVersion: LOCKFILE_VERSION,
        rootName: resolution.root.name,
        rootVersion: resolution.root.version,
        dependencies,
    };
}
/**
 * Deterministic serialization for `xo.lock` — reuses `canonicalJson`
 * (the same key-sorting serializer `fingerprintManifest`'s signable
 * bytes use) rather than inventing a second deterministic-JSON
 * implementation. `createLockfile` already sorts the `dependencies`
 * array itself (array order is preserved, not re-sorted, by
 * `canonicalJson` — see its own doc comment), so the combination gives a
 * byte-identical `xo.lock` for two resolutions of the same dependency
 * set regardless of the order resolution happened to visit them in.
 */
export function serializeLockfile(lockfile) {
    return canonicalJson(lockfile);
}
function isLockedDependency(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.name === 'string' &&
        typeof value.version === 'string' &&
        typeof value.contentHash === 'string');
}
function isXoLockfile(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const record = value;
    if (typeof record.lockfileVersion !== 'string')
        return false;
    if (typeof record.rootName !== 'string')
        return false;
    if (typeof record.rootVersion !== 'string')
        return false;
    if (!Array.isArray(record.dependencies) || !record.dependencies.every(isLockedDependency))
        return false;
    return true;
}
/** Parses and structurally validates a serialized `xo.lock`. Returns a `Result` rather than throwing on malformed JSON or an unexpected shape, per this codebase's convention for expected failure modes. */
export function parseLockfile(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (cause) {
        return err(new DependencyError(ErrorCode.PACKAGE_LOCKFILE_INVALID, 'xo.lock is not valid JSON', { cause }));
    }
    if (!isXoLockfile(parsed)) {
        return err(new DependencyError(ErrorCode.PACKAGE_LOCKFILE_INVALID, 'xo.lock does not match the expected lockfile shape'));
    }
    return ok(parsed);
}
/**
 * Checks whether `manifest`'s *currently declared* dependencies are
 * still compatible with an existing `lockfile`, i.e. whether `xo
 * install` (once it exists — deliberately not wired up in this pass)
 * could reuse the lock as-is or needs to re-resolve. This is
 * deliberately cheap: it does not re-run the solver, only checks that
 * the root identity still matches and that every currently-declared
 * `required` dependency (and any `optional` one the lock happens to
 * carry) is present in the lock at a version still inside its declared
 * range. `peer` dependencies are never independently locked (see
 * `dependency-graph.ts`), so they're skipped here the same way.
 */
export function isLockfileStale(manifest, lockfile) {
    if (manifest.name !== lockfile.rootName || manifest.version !== lockfile.rootVersion) {
        return ok(true);
    }
    const locked = new Map(lockfile.dependencies.map((dependency) => [dependency.name, dependency]));
    for (const dependency of manifest.dependencies ?? []) {
        if (dependency.kind === 'peer')
            continue;
        const lockedEntry = locked.get(dependency.name);
        if (!lockedEntry) {
            if (dependency.kind === 'optional')
                continue;
            return ok(true);
        }
        const satisfied = satisfiesRange(lockedEntry.version, dependency.versionRange);
        if (!satisfied.ok) {
            return err(new DependencyError(ErrorCode.PACKAGE_LOCKFILE_STALE, `Cannot evaluate lockfile freshness: "${dependency.versionRange}" is not a valid semver range for dependency "${dependency.name}"`));
        }
        if (!satisfied.value)
            return ok(true);
    }
    return ok(false);
}
//# sourceMappingURL=lockfile.js.map