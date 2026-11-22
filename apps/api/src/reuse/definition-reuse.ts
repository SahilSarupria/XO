/**
 * UW-15 (ADR 0044) — reuse of compiled workflows. An index from the reuse key to the definition composed for it. A hit is used only
 * if the stored definition still exists, belongs to the same compilation and still has the digest it was indexed with; anything else
 * composes afresh. Content-addressed and workspace-local: ids and digests only.
 */
import { join } from 'node:path';
import { LocalFsBlobStore } from '@xo/storage';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';

interface ReuseEntry {
  readonly definitionId: string;
  readonly compilationId: string;
  readonly definitionDigest: string;
}

const store = (w: WorkspaceRecord, c: WorkspaceDataConfig): LocalFsBlobStore =>
  new LocalFsBlobStore(join(c.dataRootDir, w.workspaceId, 'definition-reuse'));
const file = (key: string): string => `${key.replace(/^sha256:/, '').slice(0, 48)}.json`;

export async function lookupReuse(w: WorkspaceRecord, c: WorkspaceDataConfig, key: string): Promise<ReuseEntry | undefined> {
  const raw = await store(w, c).get(file(key));
  if (!raw.ok) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(raw.value)) as ReuseEntry;
  } catch {
    return undefined;
  }
}

export async function recordReuse(w: WorkspaceRecord, c: WorkspaceDataConfig, key: string, entry: ReuseEntry): Promise<void> {
  await store(w, c).replace(file(key), JSON.stringify(entry), { contentType: 'application/json' });
}
