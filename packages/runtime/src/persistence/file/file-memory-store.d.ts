import { type Result } from '@xo/types';
import type { RuntimeError } from '@xo/errors';
import type { MemoryEntryId } from '../../ids.js';
import type { MemoryEntry, MemoryQuery, MemoryScope } from '../../memory/memory-types.js';
import type { MemoryRecordStore, VersionedEnvelope } from '../runtime-store.interface.js';
/**
 * The durable, file-backed `MemoryRecordStore` — one JSON file per entry,
 * under a directory namespaced by `(scope.kind, scope.scopeId)`:
 *
 * ```
 * memory/<kind>/<encoded-scopeId>/<encoded-entryId>.json
 * ```
 *
 * This is the same structural-isolation approach `FileCheckpointRecordStore`
 * already uses for `checkpoints/<executionId>/...` (§10 of the Stage 5
 * brief: compose on top of Stage 4's persistence boundary rather than
 * inventing a new one) — every scope gets its own `FileRecordStore`
 * instance and therefore its own directory, so a bug in this class could
 * at worst corrupt *one* scope's files, never read across the directory
 * boundary into another scope's. Every read/write goes through
 * `FileRecordStore`, which is what actually provides the atomic-write,
 * checksum, and per-key-locking guarantees Stage 4 established — this
 * class adds scope-partitioning and TTL/query filtering on top, nothing
 * more.
 */
export declare class FileMemoryRecordStore implements MemoryRecordStore {
    private readonly rootDir;
    private readonly now;
    constructor(rootDir: string, now: () => Date);
    private scopeDir;
    private storeFor;
    put(entry: MemoryEntry): Promise<Result<VersionedEnvelope<MemoryEntry>, RuntimeError>>;
    get(scope: MemoryScope, id: MemoryEntryId): Promise<Result<VersionedEnvelope<MemoryEntry> | undefined, RuntimeError>>;
    query(scope: MemoryScope, query?: MemoryQuery): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>>;
    delete(scope: MemoryScope, id: MemoryEntryId): Promise<Result<boolean, RuntimeError>>;
    clear(scope: MemoryScope): Promise<Result<number, RuntimeError>>;
}
//# sourceMappingURL=file-memory-store.d.ts.map