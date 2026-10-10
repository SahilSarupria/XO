import { posix } from 'node:path';

/**
 * Path-confinement rules for everything in a package that becomes part of
 * an on-disk install location: the package `name`, its `version`, and each
 * component `path`. The installer writes `<name>/<version>/<path>` into a
 * {@link BlobStore} (`LocalFsBlobStore` maps that to a real file), so any of
 * those three being attacker-controlled could otherwise address files
 * outside this package's own `<name>/<version>/` directory — including
 * another installed package's files, which the store's own root-escape
 * check does not catch because they are still inside the store root.
 *
 * These checks are purely lexical and platform-independent on purpose: a
 * package built and validated on POSIX can be installed on Windows, so
 * Windows separators, drive prefixes, and alternate-stream colons are
 * rejected everywhere rather than only when running on Windows.
 *
 * Each function returns a human-readable reason when the value is unsafe,
 * or `undefined` when it is safe — so callers can build their own error or
 * {@link ValidationIssue} without this module depending on either.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Files the installer itself writes at the root of every package
 * directory. A component declaring one of these paths would silently
 * overwrite (or race with) the installed manifest/metadata, so they are
 * reserved. Compared case-insensitively: on case-insensitive filesystems
 * `Manifest.json` is the same file as `manifest.json`.
 */
const RESERVED_ROOT_FILES: readonly string[] = ['manifest.json', 'metadata.json'];

function segmentProblem(segment: string): string | undefined {
  if (segment.length === 0) return 'contains an empty path segment (leading, trailing, or doubled "/")';
  if (segment === '.' || segment === '..') return `contains a "${segment}" path segment`;
  if (segment.includes('\\')) return 'contains a backslash (Windows path separator)';
  if (segment.includes(':')) return 'contains ":" (Windows drive prefix or alternate data stream)';
  return undefined;
}

/**
 * A package `name` or `version` must be exactly one safe path segment:
 * it becomes a directory name directly under the store root (`name`) or
 * under the package's own directory (`version`), so allowing "/" would let
 * a package place itself inside — or alias — another package's directory.
 */
export function packageSegmentProblem(label: 'name' | 'version', value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return `package ${label} must be a non-empty string`;
  if (CONTROL_CHARACTERS.test(value)) return `package ${label} contains a control character`;
  if (value.includes('/')) return `package ${label} contains "/" and would address a nested or other package's directory`;
  const problem = segmentProblem(value);
  return problem ? `package ${label} ${problem}` : undefined;
}

/**
 * The on-disk file a component path addresses. The spec's example manifest
 * (SPECIFICATION.md §1.2) writes the `lora` and `finetune` entries as
 * directory-style paths with ONE trailing slash (`weights/lora/`), and the
 * installer has always stored such a component as a single blob at that path
 * with the slash dropped by the store. So a single trailing "/" is a
 * supported form and means the same file as the path without it; every
 * check below that cares which file is addressed (reserved names, collisions)
 * compares this normalized key, never the raw string.
 */
export function componentPathKey(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * A component `path` is relative, "/"-separated, and made only of plain
 * segments. No leading "/" (absolute), no "." / ".." segments, no empty
 * segments (so no doubled "/" and at most one trailing "/" — see
 * {@link componentPathKey}), no backslashes, no ":" and no control
 * characters.
 */
export function componentPathProblem(path: unknown): string | undefined {
  if (typeof path !== 'string' || path.length === 0) return 'component path must be a non-empty string';
  if (CONTROL_CHARACTERS.test(path)) return 'component path contains a control character';
  if (path.startsWith('/')) return 'component path is absolute';
  const key = componentPathKey(path);
  for (const segment of key.split('/')) {
    const problem = segmentProblem(segment);
    if (problem) return `component path ${problem}`;
  }
  if (RESERVED_ROOT_FILES.includes(key.toLowerCase())) return `component path "${path}" is reserved for the installer's own package file`;
  return undefined;
}

/**
 * Two components must never address the same file, or one where the other
 * needs a directory (`a` vs `a/b`): the second write would silently clobber
 * the first, or fail midway through the install and leave a partial package.
 * Compared on {@link componentPathKey}, case-insensitively (the same file on
 * case-insensitive filesystems).
 */
export function componentCollisionProblem(paths: readonly string[]): string | undefined {
  const keys = paths.map((p) => componentPathKey(p).toLowerCase());
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = keys[i] as string;
      const b = keys[j] as string;
      if (a === b) return `components "${paths[i]}" and "${paths[j]}" address the same file`;
      if (b.startsWith(`${a}/`) || a.startsWith(`${b}/`))
        return `components "${paths[i]}" and "${paths[j]}" conflict: one is a file where the other needs a directory`;
    }
  }
  return undefined;
}

/**
 * Defense-in-depth for the installer: given the already-validated
 * `prefix` (`<name>/<version>`) and a component `path`, confirms that the
 * normalized result is still strictly inside `prefix`. With
 * {@link componentPathProblem} having passed this can never fail; it
 * exists so that a future change to the segment rules cannot silently
 * reopen the hole at the one place bytes are actually written.
 */
export function confinementProblem(prefix: string, path: string): string | undefined {
  const joined = posix.normalize(`${prefix}/${path}`);
  return joined.startsWith(`${prefix}/`) && joined.length > prefix.length + 1 ? undefined : `"${path}" resolves outside "${prefix}/"`;
}
