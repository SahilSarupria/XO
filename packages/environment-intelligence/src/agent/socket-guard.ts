import { connect } from 'node:net';
import { lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { err, ok, type Result } from '@xo/types';
import { DiscoveryErrorCode, discoveryError, type DiscoveryError } from '../errors.js';

/**
 * C2 - the agent's socket trust boundary. LINUX ONLY: this is the one module of the agent that knows about the platform.
 *
 * Node's core has no API for a Unix socket's peer credentials (SO_PEERCRED), and the platform allows no native addon or new
 * dependency, so the boundary is the kernel's own file permissions instead, verified rather than assumed:
 *   - the socket lives in a PRIVATE directory (mode 0700, owned by the agent's uid, no symlink anywhere in its path, no ancestor
 *     another user could rename it away from) and the socket file itself is mode 0600 and owned by the same uid;
 *   - the kernel then lets only that uid (and root) connect to it;
 *   - the agent and the client BOTH re-verify all of this at bind / connect time, so a socket path alone is never authority and a
 *     socket planted in a shared or foreign-owned location is refused.
 * What this does NOT give is a per-connection peer check: root can connect, and the agent cannot tell two processes of its own uid
 * apart. The caller identity the agent uses is therefore the agent's own service principal, never anything a connection says.
 */

export const MAX_SOCKET_PATH_BYTES = 100; // sun_path is 108 bytes on Linux; leave headroom.

export interface GuardOptions {
  /** The uid that must own the directory and socket. Defaults to the effective uid of this process. */
  readonly uid?: number;
}

const effectiveUid = (o: GuardOptions | undefined): number => o?.uid ?? process.geteuid?.() ?? -1;

const refuse = (code: DiscoveryErrorCode, reason: string): Result<never, DiscoveryError> =>
  err(discoveryError(code, 'the agent socket location is not trusted', { reason }));

export function requireLinux(platform: NodeJS.Platform = process.platform): Result<void, DiscoveryError> {
  if (platform !== 'linux') {
    return err(discoveryError(DiscoveryErrorCode.UNSUPPORTED_OPERATION, 'the local agent is supported on Linux only', { platform }));
  }
  return ok(undefined);
}

const isNotFound = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT';

/** Pure path-shape check: absolute, normalized, NUL-free, short enough for sun_path. */
export function validateSocketPath(path: string): Result<void, DiscoveryError> {
  if (typeof path !== 'string' || path.includes('\u0000')) return refuse(DiscoveryErrorCode.INVALID_SCOPE, 'path_malformed');
  if (!isAbsolute(path) || resolve(path) !== path) return refuse(DiscoveryErrorCode.INVALID_SCOPE, 'path_not_normalized');
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) return refuse(DiscoveryErrorCode.INVALID_SCOPE, 'path_too_long');
  return ok(undefined);
}

/**
 * Verifies `dir` is a private directory this uid owns, creating it (mode 0700, parent must already exist) when absent. Fails closed
 * on anything else; it never chmods, chowns or otherwise "fixes" a directory it did not create.
 */
export async function ensurePrivateDirectory(
  dir: string,
  options?: GuardOptions & { readonly create?: boolean },
  code: DiscoveryErrorCode = DiscoveryErrorCode.INVALID_SCOPE,
): Promise<Result<void, DiscoveryError>> {
  const uid = effectiveUid(options);
  const shape = validateSocketPath(dir);
  if (!shape.ok) return shape;
  try {
    let st = await lstat(dir).catch(async (e: unknown) => {
      if (!isNotFound(e) || options?.create !== true) throw e;
      await mkdir(dir, { mode: 0o700 });
      return lstat(dir);
    });
    if (st.isSymbolicLink() || !st.isDirectory()) return refuse(code, 'dir_not_a_directory'); // ENFORCE:dir_symlink
    if (st.uid !== uid) return refuse(code, 'dir_wrong_owner'); // ENFORCE:dir_owner
    if ((st.mode & 0o077) !== 0) return refuse(code, 'dir_not_private'); // ENFORCE:dir_mode
    if ((await realpath(dir)) !== dir) return refuse(code, 'path_contains_symlink'); // ENFORCE:path_symlink
    for (let ancestor = dirname(dir); ; ancestor = dirname(ancestor)) {
      st = await lstat(ancestor);
      // An ancestor another user can write to (without the sticky bit) lets them rename our directory out from under us.
      if (st.uid !== 0 && st.uid !== uid) return refuse(code, 'ancestor_wrong_owner'); // ENFORCE:ancestor_owner
      if ((st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0) return refuse(code, 'ancestor_writable'); // ENFORCE:ancestor_writable
      if (ancestor === dirname(ancestor)) break;
    }
    return ok(undefined);
  } catch {
    return refuse(code, 'dir_unverifiable');
  }
}

/** Verifies `path` is a socket owned by this uid with no group/other permission bits. */
export async function checkSocketFile(
  path: string,
  options?: GuardOptions,
  code: DiscoveryErrorCode = DiscoveryErrorCode.INVALID_SCOPE,
): Promise<Result<void, DiscoveryError>> {
  const uid = effectiveUid(options);
  try {
    const st = await lstat(path);
    if (!st.isSocket()) return refuse(code, 'not_a_socket'); // ENFORCE:socket_type
    if (st.uid !== uid) return refuse(code, 'socket_wrong_owner'); // ENFORCE:socket_owner
    if ((st.mode & 0o077) !== 0) return refuse(code, 'socket_not_private'); // ENFORCE:socket_mode
    return ok(undefined);
  } catch {
    return refuse(code, 'socket_unverifiable');
  }
}

/** The full client-side precondition before connecting: private directory plus a private, owned socket. */
export async function verifySocketForConnect(socketPath: string, options?: GuardOptions): Promise<Result<void, DiscoveryError>> {
  const linux = requireLinux();
  if (!linux.ok) return linux;
  const shape = validateSocketPath(socketPath);
  if (!shape.ok) return shape;
  const dir = await ensurePrivateDirectory(dirname(socketPath), { ...options, create: false }, DiscoveryErrorCode.CONNECTION_FAILED);
  if (!dir.ok) return dir;
  return checkSocketFile(socketPath, options, DiscoveryErrorCode.CONNECTION_FAILED);
}

/**
 * Removes a leftover socket file from a crashed agent, but only if it is a socket this uid owns and nothing is listening on it.
 * A live listener means another agent is running: refuse rather than steal its path.
 */
export async function removeStaleSocket(path: string, options?: GuardOptions): Promise<Result<void, DiscoveryError>> {
  try {
    const st = await lstat(path);
    // Only a socket this uid owns may be removed, and never a file of any other kind. Its mode does not matter here: it is being
    // deleted, not trusted, and it sits in a directory that was just verified private.
    if (!st.isSocket()) return refuse(DiscoveryErrorCode.INVALID_SCOPE, 'not_a_socket');
    if (st.uid !== effectiveUid(options)) return refuse(DiscoveryErrorCode.INVALID_SCOPE, 'socket_wrong_owner');
  } catch (e) {
    return isNotFound(e) ? ok(undefined) : refuse(DiscoveryErrorCode.INVALID_SCOPE, 'socket_unverifiable');
  }
  const live = await new Promise<boolean>((done) => {
    const probe = connect(path);
    probe.once('connect', () => {
      probe.destroy();
      done(true);
    });
    probe.once('error', () => done(false));
  });
  if (live) return refuse(DiscoveryErrorCode.INVALID_SCOPE, 'agent_already_running');
  try {
    await unlink(path);
  } catch (e) {
    if (!isNotFound(e)) return refuse(DiscoveryErrorCode.INVALID_SCOPE, 'stale_socket_not_removable');
  }
  return ok(undefined);
}

export const socketPathIn = (dir: string, name: string): string => join(dir, name);
