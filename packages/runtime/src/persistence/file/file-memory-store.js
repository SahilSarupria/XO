import { ok } from '@xo/types';
import { join } from 'node:path';
import { isExpired } from '../../memory/memory-ttl.js';
import { FileRecordStore } from './file-record-store.js';
function matchesQuery(entry, query) {
    if (!query)
        return true;
    if (query.type !== undefined && entry.type !== query.type)
        return false;
    if (query.key !== undefined && entry.key !== query.key)
        return false;
    return true;
}
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
export class FileMemoryRecordStore {
    rootDir;
    now;
    constructor(rootDir, now) {
        this.rootDir = rootDir;
        this.now = now;
    }
    scopeDir(scope) {
        return join(this.rootDir, encodeURIComponent(scope.kind), encodeURIComponent(scope.scopeId));
    }
    storeFor(scope) {
        return new FileRecordStore(this.scopeDir(scope), this.now);
    }
    async put(entry) {
        return this.storeFor(entry.scope).save(entry.id, entry);
    }
    async get(scope, id) {
        const found = await this.storeFor(scope).get(id);
        if (!found.ok)
            return found;
        if (!found.value)
            return ok(undefined);
        if (isExpired(found.value.data, this.now))
            return ok(undefined);
        return found;
    }
    async query(scope, query) {
        const listed = await this.storeFor(scope).list();
        if (!listed.ok)
            return listed;
        const includeExpired = query?.includeExpired ?? false;
        const matched = listed.value
            .map((entry) => entry.envelope)
            .filter((entry) => includeExpired || !isExpired(entry.data, this.now))
            .filter((entry) => matchesQuery(entry.data, query))
            .slice()
            .sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt) || a.data.id.localeCompare(b.data.id));
        const limited = query?.limit !== undefined ? matched.slice(0, query.limit) : matched;
        return ok(limited);
    }
    async delete(scope, id) {
        return this.storeFor(scope).delete(id);
    }
    async clear(scope) {
        const listed = await this.storeFor(scope).list();
        if (!listed.ok)
            return listed;
        let count = 0;
        for (const entry of listed.value) {
            const deleted = await this.storeFor(scope).delete(entry.id);
            if (!deleted.ok)
                return deleted;
            if (deleted.value)
                count += 1;
        }
        return ok(count);
    }
}
//# sourceMappingURL=file-memory-store.js.map