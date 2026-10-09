import { ok, type Result } from '@xo/types';
import type { RuntimeError } from '@xo/errors';
import type { MemoryEntryId } from '../ids.js';
import type { MemoryRecordStore, VersionedEnvelope } from '../persistence/runtime-store.interface.js';
import { CURRENT_RUNTIME_STORE_VERSION } from '../persistence/versioning.js';
import { isExpired } from './memory-ttl.js';
import type { MemoryEntry, MemoryQuery, MemoryScope } from './memory-types.js';
import { scopeKey } from './memory-types.js';

function envelope(data: MemoryEntry, now: () => Date): VersionedEnvelope<MemoryEntry> {
  return Object.freeze({ version: CURRENT_RUNTIME_STORE_VERSION, persistedAt: now().toISOString(), data });
}

function matchesQuery(entry: MemoryEntry, query: MemoryQuery | undefined): boolean {
  if (!query) return true;
  if (query.type !== undefined && entry.type !== query.type) return false;
  if (query.key !== undefined && entry.key !== query.key) return false;
  return true;
}

/**
 * The default, non-durable `MemoryRecordStore` — mirrors
 * `InMemoryRuntimeStore`'s other sub-stores exactly: a `Map` per scope,
 * keyed by `scopeKey(scope)` at the outer level and `MemoryEntryId` at
 * the inner level, so one scope's entries are a structurally separate
 * object from every other scope's (§16's isolation invariant — there is
 * no code path in this class that can read across the outer `Map`'s key
 * boundary by accident).
 */
export class InMemoryDurableMemoryStore implements MemoryRecordStore {
  private readonly byScope = new Map<string, Map<string, VersionedEnvelope<MemoryEntry>>>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private bucket(scope: MemoryScope): Map<string, VersionedEnvelope<MemoryEntry>> {
    const key = scopeKey(scope);
    let bucket = this.byScope.get(key);
    if (!bucket) {
      bucket = new Map();
      this.byScope.set(key, bucket);
    }
    return bucket;
  }

  async put(entry: MemoryEntry): Promise<Result<VersionedEnvelope<MemoryEntry>, RuntimeError>> {
    const record = envelope(entry, this.now);
    this.bucket(entry.scope).set(entry.id, record);
    return ok(record);
  }

  async get(scope: MemoryScope, id: MemoryEntryId): Promise<Result<VersionedEnvelope<MemoryEntry> | undefined, RuntimeError>> {
    const found = this.byScope.get(scopeKey(scope))?.get(id);
    if (!found) return ok(undefined);
    if (isExpired(found.data, this.now)) return ok(undefined);
    return ok(found);
  }

  async query(scope: MemoryScope, query?: MemoryQuery): Promise<Result<readonly VersionedEnvelope<MemoryEntry>[], RuntimeError>> {
    const bucket = this.byScope.get(scopeKey(scope));
    if (!bucket) return ok([]);
    const includeExpired = query?.includeExpired ?? false;
    const matched = [...bucket.values()]
      .filter((entry) => includeExpired || !isExpired(entry.data, this.now))
      .filter((entry) => matchesQuery(entry.data, query))
      .sort((a, b) => a.data.createdAt.localeCompare(b.data.createdAt) || a.data.id.localeCompare(b.data.id));
    const limited = query?.limit !== undefined ? matched.slice(0, query.limit) : matched;
    return ok(limited);
  }

  async delete(scope: MemoryScope, id: MemoryEntryId): Promise<Result<boolean, RuntimeError>> {
    const bucket = this.byScope.get(scopeKey(scope));
    if (!bucket) return ok(false);
    return ok(bucket.delete(id));
  }

  async clear(scope: MemoryScope): Promise<Result<number, RuntimeError>> {
    const bucket = this.byScope.get(scopeKey(scope));
    if (!bucket) return ok(0);
    const count = bucket.size;
    bucket.clear();
    return ok(count);
  }
}
