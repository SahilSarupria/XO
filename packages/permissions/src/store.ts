import { err, ok, type Result } from '@xo/types';
import { ErrorCode, PermissionError } from '@xo/errors';
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

function matchesFilter(grant: PermissionGrant, filter?: PermissionGrantFilter): boolean {
  if (!filter) return true;
  if (filter.packageId !== undefined && grant.packageId !== filter.packageId) return false;
  if (filter.permission !== undefined && grant.permission !== filter.permission) return false;
  if (filter.capabilityId !== undefined && grant.requesterCapabilityId !== filter.capabilityId) return false;
  if (filter.lifetime !== undefined && grant.lifetime !== filter.lifetime) return false;
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
export class InMemoryPermissionStore implements PermissionStore {
  private readonly grants = new Map<string, PermissionGrant>();

  async get(id: string): Promise<Result<PermissionGrant | undefined, PermissionError>> {
    return ok(this.grants.get(id));
  }

  async set(grant: PermissionGrant): Promise<Result<void, PermissionError>> {
    this.grants.set(grant.id, grant);
    return ok(undefined);
  }

  async delete(id: string): Promise<Result<void, PermissionError>> {
    this.grants.delete(id);
    return ok(undefined);
  }

  async list(filter?: PermissionGrantFilter): Promise<Result<readonly PermissionGrant[], PermissionError>> {
    const results = [...this.grants.values()].filter((g) => matchesFilter(g, filter));
    // Deterministic order: grantedAt then id, so callers relying on
    // "most recently granted" or on stable pagination don't see Map
    // insertion-order artifacts.
    results.sort((a, b) => a.grantedAt.localeCompare(b.grantedAt) || a.id.localeCompare(b.id));
    return ok(results);
  }

  /** Test/debug convenience — not part of the {@link PermissionStore} contract. */
  size(): number {
    return this.grants.size;
  }
}

/** Wraps a thrown/rejected error from a real backend into a `PermissionError` `Result`, matching `@xo/storage`'s `LocalFsBlobStore` error-handling convention. */
export function wrapStoreError(operation: string, cause: unknown): Result<never, PermissionError> {
  return err(new PermissionError(ErrorCode.PERMISSION_STORE_ERROR, `PermissionStore.${operation} failed`, { cause }));
}
