import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LATEST_SCHEMA_VERSION, readInstance, readLockHolder } from '@xo/instance';

/**
 * UW-17 — whether this instance can serve work right now. `/readyz` (no credential, for load balancers and orchestrators) gives only
 * the check names and whether each passed; the authenticated `/ready` adds the reasons.
 */
export interface ReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export type ReadinessProbe = () => Promise<readonly ReadinessCheck[]>;

export function instanceReadiness(opts: {
  /** Where workspace data is written. */
  readonly workspaceDataDir: string;
  /** The instance data directory, when the instance has one. */
  readonly dataDir?: string;
  readonly scheduler: 'on' | 'off';
}): ReadinessProbe {
  return async () => {
    const checks: ReadinessCheck[] = [];
    const probe = join(opts.workspaceDataDir, `.ready-${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(probe, 'ok', { flag: 'wx' });
      await rm(probe, { force: true });
      checks.push({ name: 'storage', ok: true });
    } catch (cause) {
      checks.push({ name: 'storage', ok: false, detail: `cannot write to the workspace data folder: ${(cause as Error).message}` });
    }
    if (opts.dataDir !== undefined) {
      try {
        const meta = await readInstance(opts.dataDir);
        checks.push(
          meta?.schemaVersion === LATEST_SCHEMA_VERSION
            ? { name: 'schema', ok: true }
            : {
                name: 'schema',
                ok: false,
                detail: `data is at schema ${meta?.schemaVersion ?? 'none'}, this XO expects ${LATEST_SCHEMA_VERSION}`,
              },
        );
        const holder = await readLockHolder(opts.dataDir);
        checks.push(
          holder?.pid === process.pid
            ? { name: 'instance-lock', ok: true }
            : {
                name: 'instance-lock',
                ok: false,
                detail: holder === undefined ? 'the instance lock is gone' : `the lock is held by process ${holder.pid}`,
              },
        );
      } catch (cause) {
        checks.push({ name: 'schema', ok: false, detail: (cause as Error).message });
      }
    }
    checks.push({ name: 'scheduler', ok: true, detail: opts.scheduler === 'on' ? 'schedule triggers fire here' : 'off on this instance' });
    return checks;
  };
}
