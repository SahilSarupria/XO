import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * Single-writer guard for a runs directory. The journal's idempotency and replay assume ONE process drives a run directory at a time; two writers can
 * double-execute a step, because neither sees the other's in-flight intent. This is the explicit guard (not a distributed lease): a lock file created
 * exclusively, holding `{pid, host, startedAt}`.
 *   - A second writer on the same host while the first is alive is refused, with the holder named.
 *   - The same process asking again is the same writer and is let through (one process, one runner set).
 *   - A lock whose holder process is gone (same host) is taken over; the takeover renames the stale file aside and verifies what it moved.
 *   - A lock held by ANOTHER host is never taken over (liveness cannot be checked), and refused: shared network directories are not supported.
 * Limits: advisory (a process that ignores it is not stopped), single host only, and a pid reused by an unrelated process makes a stale lock look live
 * (the operator removes the file; the message says where). A takeover racing a third process in the same instant can refuse spuriously; it never admits two.
 */
export interface WriterLock {
  release(): Promise<void>;
}

export class WriterLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriterLockedError';
  }
}

export interface GuardOptions {
  readonly pid?: number;
  readonly host?: string;
  /** Whether a process exists on this host. Default: `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
};

export async function acquireWriterLock(dir: string, o: GuardOptions = {}): Promise<WriterLock> {
  const pid = o.pid ?? process.pid;
  const host = o.host ?? hostname();
  const isAlive = o.isAlive ?? alive;
  const file = join(dir, '.xo-writer.lock');
  await mkdir(dir, { recursive: true });
  const mine = JSON.stringify({ pid, host, startedAt: (o.now?.() ?? new Date()).toISOString() });
  const hint = `If you are sure no other XO process uses this directory, delete ${file}.`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, mine, { flag: 'wx' });
      return {
        release: async () => {
          try {
            if ((await readFile(file, 'utf8')) === mine) await rm(file); // never remove a lock that is not ours
          } catch {
            /* already gone */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // released between our two calls
      throw e;
    }
    let held: { pid?: unknown; host?: unknown };
    try {
      held = JSON.parse(raw) as typeof held;
    } catch {
      throw new WriterLockedError(`${dir} has an unreadable writer lock. ${hint}`);
    }
    if (typeof held.pid !== 'number' || typeof held.host !== 'string')
      throw new WriterLockedError(`${dir} has a malformed writer lock. ${hint}`);
    if (held.host !== host)
      throw new WriterLockedError(
        `${dir} is in use by pid ${held.pid} on host "${held.host}"; a runs directory must not be shared between hosts. ${hint}`,
      );
    if (held.pid === pid) return { release: async () => undefined }; // the same process is the same writer (re-entrant); only another process is excluded
    if (isAlive(held.pid))
      throw new WriterLockedError(`${dir} is in use by pid ${held.pid} on this host; only one process may drive a runs directory. ${hint}`);
    // stale: its holder is gone. Move it aside, check we moved the stale one, then retry the exclusive create.
    const aside = `${file}.stale.${pid}.${Date.now()}`;
    try {
      await rename(file, aside);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    if ((await readFile(aside, 'utf8')) !== raw) {
      // we moved somebody's fresh lock: put it back if we can, and refuse
      await rename(aside, file).catch(() => undefined);
      throw new WriterLockedError(`${dir}: another process took the lock while it was being recovered; try again.`);
    }
    await rm(aside, { force: true });
  }
  throw new WriterLockedError(`${dir}: could not take the writer lock. ${hint}`);
}
