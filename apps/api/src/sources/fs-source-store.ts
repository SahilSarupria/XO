import { randomUUID, createHash } from 'node:crypto';
import type { Result } from '@xo/types';
import { err, ok } from '@xo/types';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { BlobStore } from '@xo/storage';
import { isValidSourceId, type CreateSourceInput, type SourceRecord, type SourceStore } from './source.js';

function contentKey(sourceId: string): string {
  return `${sourceId}/content`;
}

function metadataKey(sourceId: string): string {
  return `${sourceId}/metadata.json`;
}

function mintSourceId(): string {
  return `src_${randomUUID().replace(/-/g, '')}`;
}

function decodeRecord(bytes: Uint8Array): SourceRecord | undefined {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as SourceRecord;
  } catch {
    return undefined;
  }
}

/**
 * `BlobStore`-backed `SourceStore` — same shape as `FsWorkspaceStore`
 * (P0.1) and `FsApiKeyStore`: one JSON metadata record per entity, plus
 * here, one additional raw-bytes key per entity for content. Every
 * instance is constructed already scoped to exactly one workspace's own
 * sources directory (see `workspace/workspace-context.ts#workspaceSourcesStore`)
 * — this class has no notion of `workspaceId` as a filter, only as a
 * field recorded onto each `SourceRecord` for the caller's own
 * bookkeeping/response shape.
 */
export class FsSourceStore implements SourceStore {
  constructor(private readonly store: BlobStore) {}

  async create(workspaceId: string, identityId: string, input: CreateSourceInput): Promise<Result<SourceRecord, XoError>> {
    let sourceId = mintSourceId();
    let attempts = 0;
    while (await this.store.has(metadataKey(sourceId))) {
      if (++attempts > 5) return err(new XoError(ErrorCode.UNKNOWN, 'could not mint a unique source id'));
      sourceId = mintSourceId();
    }

    const digestSha256 = createHash('sha256').update(input.bytes).digest('hex');

    const putContent = await this.store.put(contentKey(sourceId), input.bytes, { contentType: input.mediaType });
    if (!putContent.ok) return err(putContent.error);

    const record: SourceRecord = {
      sourceId,
      workspaceId,
      identityId,
      originalFilename: input.originalFilename,
      mediaType: input.mediaType,
      extension: input.extension,
      byteSize: input.bytes.length,
      digestSha256,
      createdAt: new Date().toISOString(),
      contentStorageKey: contentKey(sourceId),
      status: 'stored',
    };

    const putMetadata = await this.store.put(metadataKey(sourceId), JSON.stringify(record), { contentType: 'application/json' });
    if (!putMetadata.ok) {
      // Best-effort cleanup of the content we just wrote — an orphaned
      // content blob with no metadata record is inert (never listed,
      // never resolvable by id) but there is no reason to leave it.
      await this.store.delete(contentKey(sourceId));
      return err(putMetadata.error);
    }

    return ok(record);
  }

  async get(sourceId: string): Promise<Result<SourceRecord, NotFoundError>> {
    if (!isValidSourceId(sourceId)) return err(new NotFoundError(`source "${sourceId}"`));
    const raw = await this.store.get(metadataKey(sourceId));
    if (!raw.ok) return err(new NotFoundError(`source "${sourceId}"`));
    const record = decodeRecord(raw.value);
    if (record === undefined) return err(new NotFoundError(`source "${sourceId}" (stored record is corrupt)`));
    return ok(record);
  }

  async getContent(sourceId: string): Promise<Result<Uint8Array, NotFoundError>> {
    // Confirm the metadata record exists first — a content blob with no
    // (or a since-deleted) metadata record is never reachable through
    // this method, even if bytes happen to still be on disk (e.g. a
    // half-finished `delete()` — see below).
    const found = await this.get(sourceId);
    if (!found.ok) return err(found.error);
    const raw = await this.store.get(contentKey(sourceId));
    if (!raw.ok) return err(new NotFoundError(`source "${sourceId}" content`));
    return ok(raw.value);
  }

  async list(): Promise<Result<readonly SourceRecord[], XoError>> {
    const listed = await this.store.list();
    if (!listed.ok) {
      // No sources uploaded to this workspace yet at all — a normal
      // state, never an error a caller of `GET .../sources` should have
      // to special-case (same reasoning as `FsWorkspaceStore.listByIdentity`).
      if (listed.error.code === ErrorCode.STORAGE_OBJECT_NOT_FOUND) return ok([]);
      return err(listed.error);
    }

    const records: SourceRecord[] = [];
    for (const key of listed.value) {
      if (!key.endsWith('/metadata.json')) continue;
      const raw = await this.store.get(key);
      if (!raw.ok) continue;
      const record = decodeRecord(raw.value);
      if (record !== undefined) records.push(record);
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return ok(records);
  }

  async delete(sourceId: string): Promise<Result<void, NotFoundError>> {
    const found = await this.get(sourceId);
    if (!found.ok) return err(found.error);

    const deleteContent = await this.store.delete(contentKey(sourceId));
    // Always attempt to remove the metadata record too, even if content
    // deletion reported a failure — an orphaned metadata record pointing
    // at now-missing content is strictly worse (it would show up in
    // listings and 200 on `get()`, then 404 only on `.../content`) than
    // an orphaned content blob, which is already inert (see `create`'s
    // own comment above).
    const deleteMetadata = await this.store.delete(metadataKey(sourceId));
    if (!deleteContent.ok) return err(new NotFoundError(`source "${sourceId}" content (delete failed)`));
    if (!deleteMetadata.ok) return err(new NotFoundError(`source "${sourceId}" metadata (delete failed)`));
    return ok(undefined);
  }
}
