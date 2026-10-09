import { randomUUID } from 'node:crypto';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import { isValidWorkspaceId, type CreateWorkspaceInput, type WorkspaceRecord, type WorkspaceStore } from './workspace.js';

const RECORD_PREFIX = 'workspaces/by-id/';

function recordKey(workspaceId: string): string {
  return `${RECORD_PREFIX}${encodeURIComponent(workspaceId)}.json`;
}

function mintWorkspaceId(): string {
  return `ws_${randomUUID().replace(/-/g, '')}`;
}

function decodeRecord(bytes: Uint8Array): WorkspaceRecord | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as WorkspaceRecord;
  } catch {
    return undefined;
  }
}

/**
 * Local-filesystem `WorkspaceStore`, built on `@xo/storage`'s
 * `BlobStore` — the exact same shape `FsApiKeyStore` uses (one JSON
 * record per file, `Result`-returning throughout, no new persistence
 * abstraction invented, per the milestone's "do not introduce Postgres/
 * Redis/S3/queues" instruction). Every write goes through the injected
 * `BlobStore`, which is what actually enforces "no path escapes the
 * store root" (`LocalFsBlobStore.resolveKey`) — this class never
 * touches `node:fs` directly and never builds a filesystem path itself.
 */
export class FsWorkspaceStore implements WorkspaceStore {
  constructor(private readonly store: BlobStore) {}

  async create(identityId: string, input: CreateWorkspaceInput = {}): Promise<Result<WorkspaceRecord, XoError>> {
    // Collision odds on a 128-bit random id are negligible, but the
    // store still checks rather than silently overwriting — same
    // defensive posture `FsApiKeyStore.create` takes for `keyHash`.
    let workspaceId = mintWorkspaceId();
    let attempts = 0;
    while (await this.store.has(recordKey(workspaceId))) {
      if (++attempts > 5) return err(new XoError(ErrorCode.UNKNOWN, 'could not mint a unique workspace id'));
      workspaceId = mintWorkspaceId();
    }

    const record: WorkspaceRecord = {
      workspaceId,
      identityId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      createdAt: new Date().toISOString(),
      storageKeyPrefix: `workspace-data/${workspaceId}/`,
    };

    const putResult = await this.store.put(recordKey(workspaceId), JSON.stringify(record), { contentType: 'application/json' });
    if (!putResult.ok) return err(putResult.error);
    return ok(record);
  }

  async get(workspaceId: string): Promise<Result<WorkspaceRecord, NotFoundError>> {
    // Reject a syntactically-invalid id before ever touching storage —
    // see `isValidWorkspaceId`'s doc comment for why this is
    // defense-in-depth on top of, not instead of, the storage layer's
    // own traversal guard.
    if (!isValidWorkspaceId(workspaceId)) return err(new NotFoundError(`workspace "${workspaceId}"`));

    const raw = await this.store.get(recordKey(workspaceId));
    if (!raw.ok) return err(new NotFoundError(`workspace "${workspaceId}"`));
    const record = decodeRecord(raw.value);
    if (record === undefined) return err(new NotFoundError(`workspace "${workspaceId}" (stored record is corrupt)`));
    return ok(record);
  }

  async listByIdentity(identityId: string): Promise<Result<readonly WorkspaceRecord[], XoError>> {
    const listResult = await this.store.list(RECORD_PREFIX);
    if (!listResult.ok) {
      // No `workspaces/by-id/` prefix yet at all just means nobody has
      // ever created a workspace — that's "zero workspaces", a normal
      // state for a brand-new identity, never an error a caller of
      // `GET /workspaces` should have to handle specially.
      if (listResult.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok([]);
      return err(listResult.error);
    }

    const records: WorkspaceRecord[] = [];
    for (const key of listResult.value) {
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      const record = decodeRecord(raw.value);
      if (record !== undefined && record.identityId === identityId) records.push(record);
    }
    return ok(records);
  }
}
