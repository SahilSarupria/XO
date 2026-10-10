import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { err, ok, type Result } from '@xo/types';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from '../errors.js';

function errnoOf(e: unknown): string | null {
  return typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string'
    ? (e as { code: string }).code
    : null;
}

/** True iff `candidate` is `root` or lies beneath it. Both must already be real (symlink-free) absolute paths. */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/**
 * Validates and canonicalizes the approved root. What is authorized and
 * scanned is the REAL path, so a symlinked root cannot make the displayed
 * scope differ from the actual one.
 *
 * Rejected: relative paths, NUL bytes, a filesystem root ("/"), the user's
 * home directory itself (too broad to be a deliberate approval), missing
 * paths, non-directories.
 */
export async function resolveRoot(root: string): Promise<Result<string, DiscoveryError>> {
  if (typeof root !== 'string' || root.length === 0 || root.includes('\0')) {
    return err(discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'root must be a non-empty path without NUL bytes'));
  }
  if (!isAbsolute(root)) {
    return err(discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'root must be an absolute path'));
  }
  let real: string;
  try {
    real = await realpath(resolve(root));
  } catch (e) {
    const code = errnoOf(e);
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return err(discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'approved root does not exist', { errno: code }));
    return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'approved root could not be resolved', { errno: code }));
  }
  if (real === parse(real).root) {
    return err(discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'a filesystem root cannot be an approved scope'));
  }
  let home: string | undefined;
  try {
    home = await realpath(homedir());
  } catch {
    home = undefined;
  }
  if (home !== undefined && real === home) {
    return err(discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'the home directory itself is too broad; approve a specific subdirectory'));
  }
  try {
    const st = await lstat(real);
    if (!st.isDirectory()) return err(discoveryError(DiscoveryErrorCode.INVALID_SCOPE, 'approved root is not a directory'));
  } catch (e) {
    return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'approved root could not be inspected', { errno: errnoOf(e) }));
  }
  return ok(real);
}

/**
 * Resolves a source-relative resource key to an absolute path that is
 * PROVEN to be inside the real root. Rejects: absolute keys, `..` or `.`
 * segments, NUL, empty segments, any path whose real location (after
 * resolving every intermediate symlink) escapes the root, and a final
 * component that is itself a symlink (links are never followed).
 */
export async function resolveInside(realRoot: string, resourceKey: string): Promise<Result<string, DiscoveryError>> {
  const violation = (reason: string): Result<never, DiscoveryError> =>
    err(discoveryError(DiscoveryErrorCode.SCOPE_VIOLATION, 'resource is outside the authorized scope', { reason }));
  if (typeof resourceKey !== 'string' || resourceKey.length === 0 || resourceKey.includes('\0')) return violation('invalid_key');
  if (isAbsolute(resourceKey) || resourceKey.includes('\\')) return violation('absolute_or_backslash');
  const segments = resourceKey.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return violation('dot_or_empty_segment');
  const abs = join(realRoot, ...segments);
  if (!isInside(realRoot, abs)) return violation('lexical_escape');

  // Reject symlinks in EVERY path component, not just the final component.
  // This blocks in-root aliases (for example, "alias -> .ssh") as well as
  // escapes. Acquisition also verifies the opened descriptor to close the
  // check/open race; this preflight keeps ordinary symlink requests explicit.
  let current = realRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return violation('symlink_not_followed');
    } catch (e) {
      const code = errnoOf(e);
      if (code === 'ENOENT') return err(discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'resource no longer exists', { errno: code }));
      return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'resource could not be inspected', { errno: code }));
    }
  }

  let real: string;
  try {
    real = await realpath(abs);
  } catch (e) {
    const code = errnoOf(e);
    if (code === 'ENOENT') return err(discoveryError(DiscoveryErrorCode.SOURCE_UNAVAILABLE, 'resource no longer exists', { errno: code }));
    return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'resource could not be resolved', { errno: code }));
  }
  if (!isInside(realRoot, real)) return violation('symlink_escape');
  try {
    if ((await lstat(abs)).isSymbolicLink()) return violation('symlink_not_followed');
  } catch (e) {
    return err(discoveryError(DiscoveryErrorCode.CONNECTION_FAILED, 'resource could not be inspected', { errno: errnoOf(e) }));
  }
  return ok(abs);
}
