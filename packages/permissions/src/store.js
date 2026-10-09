import { err, ok } from '@xo/types';
import { ErrorCode, PermissionError } from '@xo/errors';
function matchesFilter(grant, filter) {
    if (!filter)
        return true;
    if (filter.packageId !== undefined && grant.packageId !== filter.packageId)
        return false;
    if (filter.permission !== undefined && grant.permission !== filter.permission)
        return false;
    if (filter.capabilityId !== undefined && grant.requesterCapabilityId !== filter.capabilityId)
        return false;
    if (filter.lifetime !== undefined && grant.lifetime !== filter.lifetime)
        return false;
    return true;
}
/**
 * A `Map`-backed {@link PermissionStore}. Not durable — cleared on process
 * exit — which is exactly right for tests and for a host that only ever
 * needs `once`/`session` grants. A host that needs `persistent` grants to
 * actually survive a restart must supply its own backend (SQLite, etc.)
 * implementing this same interface; the permission engine (`manager.ts`,
 * `policy.ts`) never changes either way.
 */
export class InMemoryPermissionStore {
    grants = new Map();
    async get(id) {
        return ok(this.grants.get(id));
    }
    async set(grant) {
        this.grants.set(grant.id, grant);
        return ok(undefined);
    }
    async delete(id) {
        this.grants.delete(id);
        return ok(undefined);
    }
    async list(filter) {
        const results = [...this.grants.values()].filter((g) => matchesFilter(g, filter));
        // Deterministic order: grantedAt then id, so callers relying on
        // "most recently granted" or on stable pagination don't see Map
        // insertion-order artifacts.
        results.sort((a, b) => a.grantedAt.localeCompare(b.grantedAt) || a.id.localeCompare(b.id));
        return ok(results);
    }
    /** Test/debug convenience — not part of the {@link PermissionStore} contract. */
    size() {
        return this.grants.size;
    }
}
/** Wraps a thrown/rejected error from a real backend into a `PermissionError` `Result`, matching `@xo/storage`'s `LocalFsBlobStore` error-handling convention. */
export function wrapStoreError(operation, cause) {
    return err(new PermissionError(ErrorCode.PERMISSION_STORE_ERROR, `PermissionStore.${operation} failed`, { cause }));
}
//# sourceMappingURL=store.js.map