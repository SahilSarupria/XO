import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ErrorCode, XoError } from '@xo/errors';

/**
 * UW-12b (ADR 0052 decision 3): a reviewer hands a waiting step to another person who may review. Only that person may then decide it;
 * an admin takes it back by delegating it to themselves. Stored beside the run (`<runsDir>/delegations/<approvalId>.json`).
 */
export interface DelegationRecord {
  readonly approvalId: string;
  readonly runId: string;
  readonly to: string;
  readonly by: string;
  readonly at: string;
  readonly reason: string;
  readonly revision: number;
}

const APPROVAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const file = (runsDir: string, approvalId: string): string => join(runsDir, 'delegations', `${approvalId}.json`);

export async function readDelegation(runsDir: string, approvalId: string): Promise<DelegationRecord | undefined> {
  if (!APPROVAL_ID.test(approvalId)) return undefined;
  try {
    return JSON.parse(await readFile(file(runsDir, approvalId), 'utf8')) as DelegationRecord;
  } catch {
    return undefined;
  }
}

/** Writes the next revision by temp-and-rename. A caller that names a revision must name the current one (409 otherwise). */
export async function writeDelegation(
  runsDir: string,
  r: Omit<DelegationRecord, 'revision'>,
  expectedRevision?: number,
): Promise<DelegationRecord> {
  const current = await readDelegation(runsDir, r.approvalId);
  if (expectedRevision !== undefined && expectedRevision !== (current?.revision ?? 0))
    throw new XoError(ErrorCode.ALREADY_EXISTS, 'this step was delegated again since you looked; reload and try again', {
      context: { reason: 'stale_revision' },
    });
  const next: DelegationRecord = { ...r, revision: (current?.revision ?? 0) + 1 };
  await mkdir(join(runsDir, 'delegations'), { recursive: true });
  const tmp = `${file(runsDir, r.approvalId)}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
  await rename(tmp, file(runsDir, r.approvalId));
  return next;
}
