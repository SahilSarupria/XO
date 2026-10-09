import type { XoManifest } from '@xo/types';
import { type Result } from '@xo/types';
import { DependencyError } from '@xo/errors';
import type { Hasher } from '@xo/crypto';
import type { DependencyResolution } from './resolver.js';
/** Bumped independently of `XoManifest.formatVersion` — the lockfile is this SDK's own artifact, not part of the `.xo` package format itself. */
export declare const LOCKFILE_VERSION = "1";
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
export declare function createLockfile(resolution: DependencyResolution, hasher?: Hasher): XoLockfile;
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
export declare function serializeLockfile(lockfile: XoLockfile): string;
/** Parses and structurally validates a serialized `xo.lock`. Returns a `Result` rather than throwing on malformed JSON or an unexpected shape, per this codebase's convention for expected failure modes. */
export declare function parseLockfile(raw: string): Result<XoLockfile, DependencyError>;
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
export declare function isLockfileStale(manifest: XoManifest, lockfile: XoLockfile): Result<boolean, DependencyError>;
//# sourceMappingURL=lockfile.d.ts.map