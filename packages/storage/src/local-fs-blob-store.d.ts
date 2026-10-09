import { type Result } from '@xo/types';
import { StorageError } from '@xo/errors';
import type { BlobMetadata, BlobStore, PutOptions } from './blob-store.interface.js';
/**
 * A real, working {@link BlobStore} backed by the local filesystem. Keys
 * are treated as `/`-separated paths under `rootDir`; every resolved path
 * is checked to still be inside `rootDir` to prevent `../` traversal
 * escaping the store.
 */
export declare class LocalFsBlobStore implements BlobStore {
    private readonly rootDir;
    constructor(rootDir: string);
    private resolveKey;
    put(key: string, data: Uint8Array | string, options?: PutOptions): Promise<Result<BlobMetadata, StorageError>>;
    get(key: string): Promise<Result<Uint8Array, StorageError>>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<Result<void, StorageError>>;
    list(prefix?: string): Promise<Result<readonly string[], StorageError>>;
}
//# sourceMappingURL=local-fs-blob-store.d.ts.map