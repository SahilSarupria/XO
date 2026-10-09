import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import type { ApiKeyRecord, ApiKeyStore } from './api-key-store.interface.js';

const RECORD_PREFIX = 'api-keys/by-hash/';

function recordKey(keyHash: string): string {
  return `${RECORD_PREFIX}${encodeURIComponent(keyHash)}.json`;
}

function decodeRecord(bytes: Uint8Array): ApiKeyRecord | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as ApiKeyRecord;
  } catch {
    return undefined;
  }
}

/**
 * Local-filesystem `ApiKeyStore`, built on `@xo/storage`'s `BlobStore` —
 * the same pattern `@xo/registry`'s `FsLicenseRepository` uses (one
 * record per file, `keyHash` -> path, `Result`-returning throughout, no
 * new persistence abstraction invented). A real multi-instance
 * deployment would want a real database behind `ApiKeyStore` instead;
 * this is the local-dev/CI/single-instance implementation, exactly the
 * role `LocalFsBlobStore` already plays for the registry.
 */
export class FsApiKeyStore implements ApiKeyStore {
  constructor(private readonly store: BlobStore) {}

  async create(record: ApiKeyRecord): Promise<Result<void, XoError>> {
    if (await this.store.has(recordKey(record.keyHash))) {
      return err(new XoError(ErrorCode.ALREADY_EXISTS, 'an API key record already exists for this key hash'));
    }
    const putResult = await this.store.put(recordKey(record.keyHash), JSON.stringify(record));
    if (!putResult.ok) return err(putResult.error);
    return ok(undefined);
  }

  async findByHash(keyHash: string): Promise<Result<ApiKeyRecord, NotFoundError>> {
    const raw = await this.store.get(recordKey(keyHash));
    if (!raw.ok) return err(new NotFoundError('API key'));
    const record = decodeRecord(raw.value);
    if (record === undefined) return err(new NotFoundError('API key (stored record is corrupt)'));
    return ok(record);
  }

  async revokeByIdentity(identityId: string): Promise<Result<{ readonly revokedCount: number }, XoError>> {
    const listResult = await this.store.list(RECORD_PREFIX);
    if (!listResult.ok) {
      // No `api-keys/by-hash/` directory yet at all means no key has
      // ever been issued to anyone — that's "unknown identity", not a
      // real storage failure, so it's reported the same way as the
      // "matched nothing" case below rather than surfacing the
      // underlying STORAGE_OBJECT_NOT_FOUND.
      if (listResult.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) {
        return err(new NotFoundError(`API key(s) for identity "${identityId}"`));
      }
      return err(listResult.error);
    }

    let matchedAny = false;
    let revokedCount = 0;
    const now = new Date().toISOString();

    for (const key of listResult.value) {
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      const record = decodeRecord(raw.value);
      if (record === undefined || record.identityId !== identityId) continue;

      matchedAny = true;
      if (record.revokedAt !== undefined) continue; // already revoked — idempotent no-op

      const updated: ApiKeyRecord = { ...record, revokedAt: now };
      const putResult = await this.store.put(key, JSON.stringify(updated));
      if (!putResult.ok) return err(putResult.error);
      revokedCount += 1;
    }

    if (!matchedAny) {
      return err(new NotFoundError(`API key(s) for identity "${identityId}"`));
    }
    return ok({ revokedCount });
  }
}
