import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * RX-1a — the instance-wide emergency stop. While it is engaged, no workflow run starts in any workspace of this instance and no
 * external call is made; a call already in flight finishes and is recorded. It is a file in the data directory, so every API process
 * that shares the directory sees it at its next check, and an operator with access to the machine can engage it even when the API is
 * not answering (`xo instance emergency-stop`). Releasing it does not restart anything: runs stopped by it need a person.
 */

export const INSTANCE_STOP_FILE = 'instance-emergency-stop.json';

export interface InstanceStop {
  readonly engaged: true;
  readonly by: string;
  readonly at: string;
  readonly reason?: string;
}

export const instanceStopPath = (dataDir: string): string => join(dataDir, INSTANCE_STOP_FILE);

/** The stop, or undefined when it is not engaged. A file that exists but cannot be read counts as engaged: the switch fails closed. */
export async function readInstanceStop(dataDir: string): Promise<InstanceStop | undefined> {
  let text: string;
  try {
    text = await readFile(instanceStopPath(dataDir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return { engaged: true, by: 'unknown', at: new Date(0).toISOString(), reason: 'the emergency stop file could not be read' };
  }
  try {
    const v = JSON.parse(text) as Partial<InstanceStop>;
    return {
      engaged: true,
      by: typeof v.by === 'string' ? v.by : 'unknown',
      at: typeof v.at === 'string' ? v.at : new Date(0).toISOString(),
      ...(typeof v.reason === 'string' ? { reason: v.reason } : {}),
    };
  } catch {
    return { engaged: true, by: 'unknown', at: new Date(0).toISOString(), reason: 'the emergency stop file is not valid JSON' };
  }
}

/** Engages the stop (atomically; engaging it again replaces who and why). */
export async function engageInstanceStop(
  dataDir: string,
  s: { readonly by: string; readonly reason?: string; readonly now?: Date },
): Promise<InstanceStop> {
  const stop: InstanceStop = {
    engaged: true,
    by: s.by,
    at: (s.now ?? new Date()).toISOString(),
    ...(s.reason !== undefined && s.reason.trim() !== '' ? { reason: s.reason.trim().slice(0, 500) } : {}),
  };
  const path = instanceStopPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(stop, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  return stop;
}

/** Releases the stop. Returns whether it was engaged. */
export async function releaseInstanceStop(dataDir: string): Promise<boolean> {
  const was = (await readInstanceStop(dataDir)) !== undefined;
  await rm(instanceStopPath(dataDir), { force: true });
  return was;
}
