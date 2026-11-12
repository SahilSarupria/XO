import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Filesystem primitives for the session subsystem. The guarantees they give, and the only ones the session
 * stores rely on:
 *
 *  - `writeJsonAtomic`: the target path holds either its previous whole content or the new whole content,
 *    never a torn file (private temp file, fsync, rename). Files are 0600, directories 0700.
 *  - `moveExclusive`: `rename` is atomic on a local POSIX filesystem, so when several callers (threads,
 *    processes on the SAME host) move the same source, exactly one succeeds and the rest see ENOENT. This
 *    is how single-use credentials and challenges are consumed.
 *
 * Neither holds on network filesystems or across hosts: a session directory must be on a local filesystem
 * and be used by one host. This is a documented, deliberate boundary (see docs/studio/AUTH_API_CONTRACT.md).
 */

const MAX_RECORD_BYTES = 16 * 1024;

export function isErrno(cause: unknown, code: string): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === code;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `<prefix><43 base64url characters>`: 256 bits from the OS CSPRNG. */
export function randomCredential(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export const CREDENTIAL_BODY = /^[A-Za-z0-9_-]{43}$/;

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function writeJsonAtomic(dir: string, name: string, value: unknown): Promise<void> {
  await ensureDir(dir);
  const target = join(dir, name);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), { encoding: 'utf8' });
    await handle.sync();
  } catch (cause) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw cause;
  }
  await handle.close();
  try {
    await rename(tmp, target);
  } catch (cause) {
    await unlink(tmp).catch(() => undefined);
    throw cause;
  }
  await syncDir(dir);
}

export async function syncDir(dir: string): Promise<void> {
  let handle;
  try {
    handle = await open(dir, constants.O_RDONLY);
  } catch (cause) {
    if (isErrno(cause, 'EISDIR') || isErrno(cause, 'EPERM') || isErrno(cause, 'EACCES')) return;
    throw cause;
  }
  try {
    await handle.sync();
  } catch (cause) {
    if (!(isErrno(cause, 'EINVAL') || isErrno(cause, 'ENOTSUP') || isErrno(cause, 'EPERM'))) throw cause;
  } finally {
    await handle.close();
  }
}

/** Reads a regular, non-symlink, size-bounded JSON file. `undefined` when absent, a symlink, not a regular file, oversize or unparseable. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (isErrno(cause, 'ENOENT') || isErrno(cause, 'ELOOP') || isErrno(cause, 'ENOTDIR')) return undefined;
    throw cause;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return undefined;
    try {
      return JSON.parse(await handle.readFile({ encoding: 'utf8' })) as T;
    } catch {
      return undefined;
    }
  } finally {
    await handle.close();
  }
}

/** Atomically moves `from` to `to`. `true` for exactly one winner among concurrent callers; `false` when the source is already gone. */
export async function moveExclusive(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (cause) {
    if (isErrno(cause, 'ENOENT')) return false;
    throw cause;
  }
}
