/**
 * PX-3 — the workspace's human rulings on review items. Append-only, like waivers: a ruling is written once under its own
 * content-derived id and never edited; a ruling that no longer fits its compilation is reported stale by the completeness
 * assessment, never silently applied.
 */
import type { BlobStore } from '@xo/storage';
import { ErrorCode, XoError } from '@xo/errors';
import type { HumanRuling } from '@xo/pre-execution';

const ID = /^rul_[0-9a-f]{24}$/;

export class FsRulingStore {
  constructor(private readonly store: BlobStore) {}

  async add(ruling: HumanRuling): Promise<void> {
    if (!ID.test(ruling.rulingId)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'malformed ruling id');
    const key = `${ruling.rulingId}.json`;
    if ((await this.store.get(key)).ok) return;
    const put = await this.store.put(key, JSON.stringify(ruling), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  }

  async list(): Promise<readonly HumanRuling[]> {
    const listed = await this.store.list();
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    const out: HumanRuling[] = [];
    for (const key of listed.value) {
      if (!key.endsWith('.json')) continue;
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      try {
        out.push(JSON.parse(new TextDecoder().decode(raw.value)) as HumanRuling);
      } catch {
        // Unreadable: not a ruling, never applied.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.rulingId.localeCompare(b.rulingId));
  }

  async forSourceSet(sourceSetId: string): Promise<readonly HumanRuling[]> {
    return (await this.list()).filter((r) => r.sourceSetId === sourceSetId);
  }
}
