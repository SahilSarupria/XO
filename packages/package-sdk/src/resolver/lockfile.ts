import type { XoManifest } from '@xo/types';
import { err, ok, type Result } from '@xo/types';
import { ErrorCode, DependencyError } from '@xo/errors';
import type { Hasher } from '@xo/crypto';
import { Sha256Hasher } from '@xo/crypto';
import { canonicalJson, fingerprintManifest } from '../hashing/fingerprint.js';
import { satisfiesRange } from '../manifest/semver.js';
import type { DependencyResolution } from './resolver.js';

/** Bumped independently of `XoManifest.formatVersion` — the lockfile is this SDK's own artifact, not part of the `.xo` package format itself. */
export const LOCKFILE_VERSION = '1';

/** One resolved dependency's pinned entry — exact version, never a range, plus a content hash so two installs from the same lockfile are guaranteed identical (Cargo.lock/package-lock.json's guarantee). */
export interface LockedDependency {
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
}

export interface XoLockfile {
  readonly lockfileVersion: string;
  readonly rootName: string;
  readonly rootVersion: string;
  readonly dependencies: readonly LockedDependency[];
}

/**
 * Builds an `xo.lock`-shaped value from a resolver result. Every
 * resolved dependency (direct and transitive alike — `resolveDependencies`
 * already flattened the tree) is recorded with its exact version and a
 * content hash (`fingerprintManifest`, the same manifest fingerprint
 * `comparePackages`/the installer already use to recognize identical
 * package content). Sorted by name so the output is stable regardless of
 * resolution order.
 */
export function createLockfile(resolution: DependencyResolution, hasher: Hasher = new Sha256Hasher()): XoLockfile {
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
export function serializeLockfile(lockfile: XoLockfile): string {
  return canonicalJson(lockfile);
}

function isLockedDependency(value: unknown): value is LockedDependency {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).name === 'string' &&
    typeof (value as Record<string, unknown>).version === 'string' &&
    typeof (value as Record<string, unknown>).contentHash === 'string'
  );
}

function isXoLockfile(value: unknown): value is XoLockfile {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.lockfileVersion !== 'string') return false;
  if (typeof record.rootName !== 'string') return false;
  if (typeof record.rootVersion !== 'string') return false;
  if (!Array.isArray(record.dependencies) || !record.dependencies.every(isLockedDependency)) return false;
  return true;
}

/** Parses and structurally validates a serialized `xo.lock`. Returns a `Result` rather than throwing on malformed JSON or an unexpected shape, per this codebase's convention for expected failure modes. */
export function parseLockfile(raw: string): Result<XoLockfile, DependencyError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
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
export function isLockfileStale(manifest: XoManifest, lockfile: XoLockfile): Result<boolean, DependencyError> {
  if (manifest.name !== lockfile.rootName || manifest.version !== lockfile.rootVersion) {
    return ok(true);
  }
  const locked = new Map(lockfile.dependencies.map((dependency) => [dependency.name, dependency] as const));
  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.kind === 'peer') continue;
    const lockedEntry = locked.get(dependency.name);
    if (!lockedEntry) {
      if (dependency.kind === 'optional') continue;
      return ok(true);
    }
    const satisfied = satisfiesRange(lockedEntry.version, dependency.versionRange);
    if (!satisfied.ok) {
      return err(
        new DependencyError(
          ErrorCode.PACKAGE_LOCKFILE_STALE,
          `Cannot evaluate lockfile freshness: "${dependency.versionRange}" is not a valid semver range for dependency "${dependency.name}"`,
        ),
      );
    }
    if (!satisfied.value) return ok(true);
  }
  return ok(false);
}
