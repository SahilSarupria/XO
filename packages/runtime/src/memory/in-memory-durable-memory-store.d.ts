import { type Result } from '@xo/types';
import type { RuntimeError } from '@xo/errors';
import type { MemoryEntryId } from '../ids.js';
import type { MemoryRecordStore, VersionedEnvelope } from '../persistence/runtime-store.interface.js';
import type { MemoryEntry, MemoryQuery, MemoryScope } from './memory-types.js';
/**
 * The default, non-durable `MemoryRecordStore` — mirrors
 * `InMemoryRuntimeStore`'s other sub-stores exactly: a `Map` per scope,
 * keyed by `scopeKey(scope)` at the outer level and `MemoryEntryId` at
 * the inner level, so one scope's entries are a structurally separate
 * object from every other scope's (§16's isolation invariant — there is
 * no code path in this class that can read across the outer `Map`'s key
 * boundary by accident).
 */
export declare class InMemoryDurableMemoryStore implements MemoryRecordStore {
    private readonly now;
    private readonly byScope;
    constructor(now?: () => Date);
    private bucket;
    put(entry: MemoryEntry): Promise<Result<VersionedEnvelope<MemoryEntry>, RuntimeError>>;
    get(scope: MemoryScope, id: MemoryEntryId): Promise<Result<VersionedEnvelope<MemoryEntry> | undefined, RuntimeError>>;
    query(scope: MemoryScope, query?: MemoryQuery): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>>;
    delete(scope: MemoryScope, id: MemoryEntryId): Promise<Result<boolean, RuntimeError>>;
    clear(scope: MemoryScope): Promise<Result<number, RuntimeError>>;
}
//# sourceMappingURL=in-memory-durable-memory-store.d.ts.map