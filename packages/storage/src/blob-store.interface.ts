import type { Result } from '@xo/types';
import type { StorageError } from '@xo/errors';

export interface PutOptions {
  readonly contentType?: string;
}

export interface BlobMetadata {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
}

/**
 * Storage port for XO package components (manifest.json, knowledge/graph.json,
 * weights/lora/*, ...). A real deployment backs this with object storage
 * (S3/GCS/R2); local dev and CI back it with {@link LocalFsBlobStore}.
 * Neither the compiler nor the registry may reach into the filesystem or
 * an SDK directly — everything goes through this interface, so swapping
 * the backend never touches call sites.
 */
export interface BlobStore {
  put(key: string, data: Uint8Array | string, options?: PutOptions): Promise<Result<BlobMetadata, StorageError>>;
  get(key: string): Promise<Result<Uint8Array, StorageError>>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<Result<void, StorageError>>;
  list(prefix?: string): Promise<Result<readonly string[], StorageError>>;
}

/**
 * P1.0 M6 — a {@link BlobStore} that can also make a write ATOMIC in the two ways idempotency records need and plain `put` cannot:
 *
 *  - `putIfAbsent`: creates the blob only if the key does not exist yet, as one atomic step (`created: false` when it did). The
 *    content is complete the moment the key becomes visible — a concurrent reader never sees a partial blob.
 *  - `replace`: overwrites an existing blob so a concurrent reader (or a crash) sees either the old or the new content in full,
 *    never a truncated mixture.
 *
 * Scope: atomic with respect to other processes using the same local filesystem. It is NOT a distributed lock.
 */
export interface AtomicBlobStore extends BlobStore {
  putIfAbsent(key: string, data: Uint8Array | string, options?: PutOptions): Promise<Result<{ readonly created: boolean }, StorageError>>;
  replace(key: string, data: Uint8Array | string, options?: PutOptions): Promise<Result<BlobMetadata, StorageError>>;
}
