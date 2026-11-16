import { open, readFile, rm } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';
import { LOCK_FILE } from './metadata.js';

/**
 * UW-17 (ADR 0023, rule 6) — one runner per instance. Whatever writes to a data directory (the running instance, a backup, a restore,
 * an erasure) holds its lock. The interface is all callers see, so a distributed lease (one row in a database, a cloud lock) can
 * replace the file without touching them.
 */
export interface LockHolder {
  readonly pid: number;
  readonly hostname: string;
  readonly purpose: string;
  readonly since: string;
}

export interface InstanceLock {
  readonly holder: LockHolder;
  release(): Promise<void>;
}

export class LockHeldError extends Error {
  constructor(
    readonly holder: LockHolder,
    readonly path: string,
  ) {
    super(
      `this instance is in use (${holder.purpose}, process ${holder.pid} on ${holder.hostname} since ${holder.since}); stop it first. ` +
        `If that process is gone and the lock was left behind on another machine, remove ${path} by hand.`,
    );
  }
}

export interface LockOptions {
  readonly purpose: string;
  readonly now?: () => Date;
  readonly hostname?: string;
  readonly pid?: number;
  /** Whether a process on THIS host is still running. Default: signal 0. */
  readonly isAlive?: (pid: number) => boolean;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function readLockHolder(dataDir: string): Promise<LockHolder | undefined> {
  try {
    return JSON.parse(await readFile(join(dataDir, LOCK_FILE), 'utf8')) as LockHolder;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (cause instanceof SyntaxError) return { pid: 0, hostname: 'unknown', purpose: 'unknown (unreadable lock file)', since: 'unknown' };
    throw cause;
  }
}

/** A lock left by a process that is no longer running on this host can be taken over; anything else is refused. */
export async function lockIsStale(holder: LockHolder, opts: Pick<LockOptions, 'hostname' | 'isAlive'> = {}): Promise<boolean> {
  const host = opts.hostname ?? osHostname();
  return holder.hostname === host && holder.pid > 0 && !(opts.isAlive ?? processAlive)(holder.pid);
}

export async function acquireInstanceLock(dataDir: string, opts: LockOptions): Promise<InstanceLock> {
  const path = join(dataDir, LOCK_FILE);
  const holder: LockHolder = {
    pid: opts.pid ?? process.pid,
    hostname: opts.hostname ?? osHostname(),
    purpose: opts.purpose,
    since: (opts.now ?? (() => new Date()))().toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(holder)}\n`);
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        holder,
        async release() {
          if (released) return;
          released = true;
          const current = await readLockHolder(dataDir);
          // Never remove a lock someone else took over after a stale-lock recovery.
          if (current !== undefined && current.pid === holder.pid && current.since === holder.since) await rm(path, { force: true });
        },
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      const existing = await readLockHolder(dataDir);
      if (existing === undefined) continue; // released between our attempt and the read
      if (attempt === 0 && (await lockIsStale(existing, opts))) {
        await rm(path, { force: true });
        continue;
      }
      throw new LockHeldError(existing, path);
    }
  }
  throw new LockHeldError((await readLockHolder(dataDir))!, path);
}
