import { err, ok, type Result } from '@xo/types';
import { ErrorCode, RuntimeError } from '@xo/errors';
import { join } from 'node:path';
import type { VersionedEnvelope } from '../runtime-store.interface.js';
import { CURRENT_RUNTIME_STORE_VERSION } from '../versioning.js';
import { atomicWriteJson, deleteFile, KeyedAsyncLock, listJsonFiles, readJsonChecked } from './atomic-file-io.js';

function encodeId(id: string): string {
  // Ids in this system (branded strings) are expected to already be
  // filesystem-safe (no path separators), but encoding defensively costs
  // nothing and protects against a future id format that isn't.
  return encodeURIComponent(id);
}

interface OnDiskRecord {
  readonly version: number;
  readonly persistedAt: string;
  readonly data: unknown;
}

/**
 * A generic, file-backed, versioned key-value store — one JSON file per
 * record, under `dir`. Every `FileRuntimeStore` sub-store is built on
 * top of one or more of these rather than reimplementing atomic-write /
 * corruption-check / locking / versioning logic four times.
 */
export class FileRecordStore<T> {
  private readonly lock = new KeyedAsyncLock();

  constructor(
    private readonly dir: string,
    private readonly now: () => Date,
    /** Advances a record stored at an older `version` to the current shape. Only ever called when `storedVersion !== CURRENT_RUNTIME_STORE_VERSION`; see `versioning.ts`. The default throws — with no migrations registered yet (`CURRENT_RUNTIME_STORE_VERSION` is still `1`), *any* other stored version is genuinely unsupported, and silently passing the raw data through as if it matched the current shape would be a real data-integrity risk, not a safe fallback. */
    private readonly migrate: (storedVersion: number, raw: unknown) => T = (storedVersion) => {
      throw new Error(`No migration registered to advance a persisted record from version ${storedVersion} to ${CURRENT_RUNTIME_STORE_VERSION}`);
    },
  ) {}

  private pathFor(id: string): string {
    return join(this.dir, `${encodeId(id)}.json`);
  }

  async save(id: string, data: T): Promise<Result<VersionedEnvelope<T>, RuntimeError>> {
    return this.lock.withLock(this.pathFor(id), async () => {
      const record: OnDiskRecord = { version: CURRENT_RUNTIME_STORE_VERSION, persistedAt: this.now().toISOString(), data };
      try {
        await atomicWriteJson(this.pathFor(id), record);
        return ok({ version: record.version, persistedAt: record.persistedAt, data });
      } catch (cause) {
        return err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Failed to persist record "${id}" to "${this.dir}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause }));
      }
    });
  }

  async get(id: string): Promise<Result<VersionedEnvelope<T> | undefined, RuntimeError>> {
    const result = await readJsonChecked(this.pathFor(id));
    if (result.kind === 'missing') return ok(undefined);
    if (result.kind === 'corrupt') {
      return err(new RuntimeError(ErrorCode.RUNTIME_RETRIEVAL_FAILED, `Corrupt record "${id}" in "${this.dir}": ${result.reason}`));
    }
    const raw = result.payload as OnDiskRecord;
    if (typeof raw.version !== 'number') {
      return err(new RuntimeError(ErrorCode.RUNTIME_RETRIEVAL_FAILED, `Record "${id}" in "${this.dir}" is missing a version field`));
    }
    try {
      const data = raw.version === CURRENT_RUNTIME_STORE_VERSION ? (raw.data as T) : this.migrate(raw.version, raw.data);
      return ok({ version: CURRENT_RUNTIME_STORE_VERSION, persistedAt: raw.persistedAt, data });
    } catch (cause) {
      return err(new RuntimeError(ErrorCode.RUNTIME_RETRIEVAL_FAILED, `Failed to migrate record "${id}" from version ${raw.version}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }));
    }
  }

  async list(): Promise<Result<readonly { readonly id: string; readonly envelope: VersionedEnvelope<T> }[], RuntimeError>> {
    const files = await listJsonFiles(this.dir);
    const results: { readonly id: string; readonly envelope: VersionedEnvelope<T> }[] = [];
    for (const file of files.slice().sort()) {
      const id = decodeURIComponent(file.replace(/\.json$/, ''));
      const record = await this.get(id);
      if (!record.ok) return record;
      if (record.value) results.push({ id, envelope: record.value });
    }
    return ok(results);
  }

  async delete(id: string): Promise<Result<boolean, RuntimeError>> {
    return this.lock.withLock(this.pathFor(id), async () => {
      try {
        return ok(await deleteFile(this.pathFor(id)));
      } catch (cause) {
        return err(new RuntimeError(ErrorCode.RUNTIME_EXECUTION_FAILED, `Failed to delete record "${id}" from "${this.dir}": ${cause instanceof Error ? cause.message : String(cause)}`, { cause }));
      }
    });
  }
}
