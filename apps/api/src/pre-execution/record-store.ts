/**
 * PX-6/PX-7 — a small append-only JSON record store for pre-execution artifacts (workflow definitions, readiness
 * certificates). A record is written once under its content-derived id and never edited or deleted.
 */
import type { BlobStore } from '@xo/storage';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';

export class JsonRecordStore<T> {
  constructor(
    private readonly store: BlobStore,
    private readonly idPattern: RegExp,
    private readonly what: string,
  ) {}

  async put(id: string, record: T): Promise<void> {
    if (!this.idPattern.test(id)) throw new XoError(ErrorCode.INVALID_ARGUMENT, `malformed ${this.what} id`);
    const key = `${id}.json`;
    if ((await this.store.get(key)).ok) return;
    const put = await this.store.put(key, JSON.stringify(record), { contentType: 'application/json' });
    if (!put.ok) throw put.error;
  }

  async get(id: string): Promise<T> {
    if (!this.idPattern.test(id)) throw new NotFoundError(`${this.what} "${id}"`);
    const raw = await this.store.get(`${id}.json`);
    if (!raw.ok) throw new NotFoundError(`${this.what} "${id}"`);
    try {
      return JSON.parse(new TextDecoder().decode(raw.value)) as T;
    } catch {
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `${this.what} "${id}" is unreadable`);
    }
  }

  async list(): Promise<readonly T[]> {
    const listed = await this.store.list();
    if (!listed.ok) {
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return [];
      throw listed.error;
    }
    const out: T[] = [];
    for (const key of [...listed.value].sort()) {
      if (!key.endsWith('.json')) continue;
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      try {
        out.push(JSON.parse(new TextDecoder().decode(raw.value)) as T);
      } catch {
        // Unreadable: skipped, never served as a record.
      }
    }
    return out;
  }
}
