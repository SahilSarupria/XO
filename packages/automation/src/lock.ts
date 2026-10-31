import { open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** Thrown when another live engine already owns the state directory. */
export class EngineLockedError extends Error {
  constructor(
    readonly holder: { readonly pid: number; readonly host: string; readonly startedAt: string },
    path: string,
  ) {
    super(`state directory is already in use by pid ${holder.pid} on ${holder.host} (since ${holder.startedAt}); lock file ${path}`);
    this.name = 'EngineLockedError';
  }
}

export interface LockHandle {
  readonly path: string;
  /** true when a dead holder's lock was taken over */
  readonly tookOver: boolean;
  release(): Promise<void>;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
};

/**
 * Single-writer lock for an engine state directory (`engine.lock`, created with O_EXCL).
 * Two engines on one directory would interleave ledger appends and keep separate dedupe sets, so the second one is refused.
 * A lock whose holder is a dead process ON THIS HOST is taken over; a lock from another host is never taken over
 * automatically (a shared network directory needs a real shared store — see docs/AUTOMATION_OPERATIONS.md).
 */
export async function acquireEngineLock(dir: string, pid = process.pid): Promise<LockHandle> {
  const path = join(dir, 'engine.lock');
  const mine = JSON.stringify({ pid, host: hostname(), startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(path, 'wx');
      await fh.writeFile(mine);
      await fh.close();
      return { path, tookOver: attempt > 0, release: () => rm(path, { force: true }) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let holder: { pid: number; host: string; startedAt: string };
      try {
        holder = JSON.parse(await readFile(path, 'utf8')) as typeof holder;
      } catch {
        throw new EngineLockedError({ pid: -1, host: 'unknown', startedAt: 'unknown' }, path); // unreadable lock: do not guess
      }
      if (holder.host === hostname() && holder.pid !== pid && !alive(holder.pid)) {
        await rm(path, { force: true }); // stale: holder died without releasing
        continue;
      }
      throw new EngineLockedError(holder, path);
    }
  }
  throw new EngineLockedError({ pid: -1, host: 'unknown', startedAt: 'unknown' }, path);
}
