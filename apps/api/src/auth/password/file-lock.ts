import { mkdir, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isErrno } from '../session/fs-util.js';

/**
 * A directory-based mutex (`mkdir` is atomic on a local POSIX filesystem): held while one process mutates an account
 * record, so the server and the operator CLI cannot overwrite each other's change. A lock older than `staleMs` is
 * taken over (its holder crashed). Local-filesystem, single-host only — the same boundary as the session store.
 */
export async function withLock<T>(
  baseDir: string,
  key: string,
  work: () => Promise<T>,
  options: { staleMs?: number; waitMs?: number } = {},
): Promise<T> {
  const staleMs = options.staleMs ?? 15_000;
  const waitMs = options.waitMs ?? 5_000;
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const lock = join(baseDir, `${key}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (cause) {
      if (!isErrno(cause, 'EEXIST')) throw cause;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => undefined,
      );
      if (age !== undefined && age > staleMs) {
        await rmdir(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) throw new Error('could not acquire the account lock in time');
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 20));
    }
  }
  try {
    return await work();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}
