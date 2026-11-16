import { lstat, rm } from 'node:fs/promises';
import { directoryUsage } from './backup.js';
import { acquireInstanceLock, type LockOptions } from './lock.js';
import { InstanceError, readInstance } from './metadata.js';

/**
 * UW-17 — deleting an instance, with proof. Everything the instance keeps (the data directory: workspaces, sources, runs, audit,
 * access keys, sessions, connector tokens, encrypted secrets) and what it keeps elsewhere on purpose (the secrets key, audit anchors)
 * is removed, then every path is checked to be gone. The receipt says what was there and that it is no longer there.
 *
 * Removing files does not guarantee the bytes are unrecoverable from the storage medium (SSD wear levelling, snapshots, backups).
 * Where that matters, keep the data directory on an encrypted volume and destroy the volume or its key as well.
 */
export interface ErasureReceipt {
  readonly instanceId: string;
  readonly erasedAt: string;
  readonly paths: readonly {
    readonly path: string;
    readonly role: string;
    readonly existedBefore: boolean;
    readonly files: number;
    readonly bytes: number;
    readonly absentAfter: boolean;
  }[];
  /** True only when every path is confirmed absent. */
  readonly verified: boolean;
  readonly note: string;
}

export interface EraseOptions {
  readonly dataDir: string;
  /** Must equal the instance id in `instance.json`: deleting an instance is never a default. */
  readonly confirmInstanceId: string;
  /** Paths outside the data directory that belong to this instance (its secrets key file, its audit anchor folder). */
  readonly alsoRemove?: readonly { readonly path: string; readonly role: string }[];
  readonly now?: () => Date;
  readonly lock?: Omit<LockOptions, 'purpose'>;
}

async function present(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw cause;
  }
}

export async function eraseInstance(opts: EraseOptions): Promise<ErasureReceipt> {
  const meta = await readInstance(opts.dataDir);
  if (meta === undefined) throw new InstanceError(`${opts.dataDir} is not an XO instance; nothing was removed`);
  if (opts.confirmInstanceId !== meta.instanceId) {
    throw new InstanceError(`the confirmation does not match this instance (${meta.instanceId}); nothing was removed`);
  }
  // Refuses while the instance (or a backup) runs. The lock goes with the directory.
  await acquireInstanceLock(opts.dataDir, { ...opts.lock, purpose: 'erase' });
  const targets = [{ path: opts.dataDir, role: 'data directory' }, ...(opts.alsoRemove ?? [])];
  const before = await Promise.all(
    targets.map(async (t) => ({ ...t, existedBefore: await present(t.path), ...(await directoryUsage(t.path)) })),
  );
  for (const t of targets) await rm(t.path, { recursive: true, force: true, maxRetries: 3 });
  const paths = await Promise.all(before.map(async (b) => ({ ...b, absentAfter: !(await present(b.path)) })));
  return {
    instanceId: meta.instanceId,
    erasedAt: (opts.now ?? (() => new Date()))().toISOString(),
    paths,
    verified: paths.every((p) => p.absentAfter),
    note: 'Files were removed and confirmed absent. This does not erase copies in backups or snapshots, or bytes the storage medium may retain; for that, also destroy the encrypted volume or its key.',
  };
}
