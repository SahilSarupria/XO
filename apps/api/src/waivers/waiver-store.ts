/**
 * PX-2 — the workspace's source-quality waivers. Append-only: a waiver is written once under its own id and never edited
 * or deleted (a reviewer who changes their mind records nothing new; the source is recompiled or replaced instead). Every
 * read verifies each waiver's digest; a waiver that fails is reported by the assessment, never applied.
 */
import type { BlobStore } from '@xo/storage';
import { ErrorCode, XoError } from '@xo/errors';
import type { SourceWaiver } from '@xo/pre-execution';

const ID = /^wvr_[0-9a-f]{24}$/;

export class FsWaiverStore {
  constructor(private readonly store: BlobStore) {}

  async add(waiver: SourceWaiver): Promise<void> {
    if (!ID.test(waiver.waiverId)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'malformed waiver id');
    const key = `${waiver.waiverId}.json`;
    const existing = await this.store.get(key);
    if (existing.ok) return; // the same decision recorded twice is one waiver (the id is its content digest)
    const put = await this.store.put(key, JSON.stringify(waiver), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  }

  async list(): Promise<readonly SourceWaiver[]> {
    const listed = await this.store.list();
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    const out: SourceWaiver[] = [];
    for (const key of listed.value) {
      if (!key.endsWith('.json')) continue;
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      try {
        out.push(JSON.parse(new TextDecoder().decode(raw.value)) as SourceWaiver);
      } catch {
        // An unreadable file is not a waiver; it is skipped, and nothing it might have said is applied.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.waiverId.localeCompare(b.waiverId));
  }

  async forDigests(digests: ReadonlySet<string>): Promise<readonly SourceWaiver[]> {
    return (await this.list()).filter((w) => digests.has(w.digestSha256));
  }
}
