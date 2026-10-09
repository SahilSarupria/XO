import { type Result } from '@xo/types';
import { PermissionError } from '@xo/errors';
import type { PermissionGrant, PermissionGrantFilter } from './grant.js';
/**
 * Storage port for persisted `allow` grants (§11). Deliberately not
 * dependent on a database — a real deployment backs this with SQLite, an
 * encrypted store, an OS credential store, or cloud storage; this package
 * only ships {@link InMemoryPermissionStore}, for tests and for hosts that
 * only need `once`/`session` lifetimes. Every method returns a `Result`
 * (see `@xo/types`), matching `@xo/storage`'s `BlobStore` — a store
 * backend failing (disk full, SQLite locked, network partition) is an
 * expected, recoverable failure mode, not a programmer error.
 */
export interface PermissionStore {
    get(id: string): Promise<Result<PermissionGrant | undefined, PermissionError>>;
    set(grant: PermissionGrant): Promise<Result<void, PermissionError>>;
    delete(id: string): Promise<Result<void, PermissionError>>;
    list(filter?: PermissionGrantFilter): Promise<Result<readonly PermissionGrant[], PermissionError>>;
}
/**
 * A `Map`-backed {@link PermissionStore}. Not durable — cleared on process
 * exit — which is exactly right for tests and for a host that only ever
 * needs `once`/`session` grants. A host that needs `persistent` grants to
 * actually survive a restart must supply its own backend (SQLite, etc.)
 * implementing this same interface; the permission engine (`manager.ts`,
 * `policy.ts`) never changes either way.
 */
export declare class InMemoryPermissionStore implements PermissionStore {
    private readonly grants;
    get(id: string): Promise<Result<PermissionGrant | undefined, PermissionError>>;
    set(grant: PermissionGrant): Promise<Result<void, PermissionError>>;
    delete(id: string): Promise<Result<void, PermissionError>>;
    list(filter?: PermissionGrantFilter): Promise<Result<readonly PermissionGrant[], PermissionError>>;
    /** Test/debug convenience — not part of the {@link PermissionStore} contract. */
    size(): number;
}
/** Wraps a thrown/rejected error from a real backend into a `PermissionError` `Result`, matching `@xo/storage`'s `LocalFsBlobStore` error-handling convention. */
export declare function wrapStoreError(operation: string, cause: unknown): Result<never, PermissionError>;
//# sourceMappingURL=store.d.ts.map