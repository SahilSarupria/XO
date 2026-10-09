import { join } from 'node:path';
import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import { LocalFsBlobStore } from '@xo/storage';
import { isAuthenticatedPrincipal, type AuthenticatedPrincipal } from '@xo/permissions';
import type { ApiRequest } from '../http/types.js';
import type { WorkspaceRecord, WorkspaceStore } from './workspace.js';

/**
 * The one thing every workspace-*bound* route (package/registry/runtime)
 * needs beyond `WorkspaceStore` itself: a single, server-controlled root
 * directory that per-workspace data lives under. Deliberately a
 * different root than the one `WorkspaceStore` itself uses for
 * *metadata* records (`workspacesDir`, P0.1) — this one holds actual
 * package/registry bytes, which is a meaningfully different retention/
 * size/access pattern than a handful of small JSON ownership records,
 * even though both are, today, plain `LocalFsBlobStore` directories.
 */
export interface WorkspaceDataConfig {
  readonly dataRootDir: string;
}

/**
 * P1.0 M1 — the authenticated initiating principal of this request, or a
 * fail-closed error. Protected execution paths call this (after
 * `requireOwnedWorkspace`) instead of reading identity ad hoc; there is
 * deliberately no fallback principal, so a request that somehow reached a
 * protected path unauthenticated is refused rather than attributed to a
 * default. The principal must also agree with `req.identity` (the
 * workspace-ownership identity).
 */
export function requirePrincipal(req: ApiRequest): AuthenticatedPrincipal {
  const principal = req.principal;
  if (!isAuthenticatedPrincipal(principal) || req.identity === undefined || principal.id !== req.identity.identityId) {
    throw new XoError(ErrorCode.UNKNOWN, 'internal error: protected route reached with no authenticated principal');
  }
  return principal;
}

/**
 * Resolves the `:workspaceId` route param to a `WorkspaceRecord` this
 * request's authenticated identity actually owns — or throws
 * `NotFoundError`, identically whether the id doesn't resolve to any
 * workspace at all or resolves to one owned by someone else. Every
 * workspace-bound route (package/registry/runtime) calls this exactly
 * once, at the top of its handler, before touching any storage — this
 * is the single enforcement point for "identity A cannot reach identity
 * B's workspace" across all three route files, mirroring
 * `workspace-routes.ts#getWorkspace`'s own reasoning.
 */
export async function requireOwnedWorkspace(req: ApiRequest, workspaceStore: WorkspaceStore): Promise<WorkspaceRecord> {
  if (req.identity === undefined) {
    // Unreachable in practice — every path this function is called from
    // is registered behind the global auth middleware (see `auth.ts`'s
    // `EXEMPT_PATHS`, which does not include any workspace-bound path) —
    // kept as a defensive assertion, same posture `workspace-routes.ts`'s
    // `requireIdentity` takes.
    throw new XoError(ErrorCode.UNKNOWN, 'internal error: workspace-bound route reached with no resolved identity');
  }
  const workspaceId = req.params['workspaceId'];
  if (workspaceId === undefined) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing workspace id in route');
  }

  const found = await workspaceStore.get(workspaceId);
  if (!found.ok) throw found.error; // NotFoundError — unknown or malformed id, fails closed as 404

  if (found.value.identityId !== req.identity.identityId) {
    // Same workspace exists, but not owned by this caller — reported
    // identically to "doesn't exist" (see `requireOwnedWorkspace`'s own
    // doc comment above): never leak that a given workspace id belongs
    // to someone.
    throw new NotFoundError(`workspace "${workspaceId}"`);
  }

  return found.value;
}

/**
 * The `BlobStore` `PackageInstaller` (package-routes.ts, and
 * runtime-routes.ts's `bootstrapRuntime`) reads/writes for a given
 * workspace — a real subdirectory `<dataRootDir>/<workspaceId>/packages`,
 * never a client-supplied path. `runtime-routes.ts` and
 * `package-routes.ts` deliberately share this one function (not two
 * separate ones) because they share the same concern: "packages
 * installed into this workspace" is exactly the state both `xo install`
 * (package-routes) and `xo run`/`xo workflow` (runtime-routes) read —
 * the same relationship the original `?store=` query parameter
 * expressed when both were pointed at the same CLI-supplied directory.
 */
export function workspacePackagesStore(record: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, record.workspaceId, 'packages'));
}

/**
 * The `BlobStore` `RegistryClient` (registry-routes.ts) reads/writes
 * for a given workspace — deliberately a *separate* subdirectory from
 * `workspacePackagesStore` above (`.../registry`, not `.../packages`):
 * "packages installed for execution" and "packages published to this
 * workspace's registry" are different concerns that happen to share a
 * workspace, not the same data, and keeping them in separate
 * directories avoids any chance of a key collision between
 * `PackageInstaller`'s and `RegistryClient`'s own internal index files.
 */
export function workspaceRegistryStore(record: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, record.workspaceId, 'registry'));
}

/**
 * The `BlobStore` `FsSourceStore` (P0.3, `sources/fs-source-store.ts`)
 * reads/writes for a given workspace — a real subdirectory
 * `<dataRootDir>/<workspaceId>/sources`, never a client-supplied path.
 * A third sibling of `workspacePackagesStore`/`workspaceRegistryStore`
 * above, for the same reason those two are separate from each other:
 * "raw uploaded source documents awaiting compilation" is a distinct
 * concern from both "packages installed for execution" and "packages
 * published to this workspace's registry", even though all three
 * happen to live under the same workspace.
 */
export function workspaceSourcesStore(record: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, record.workspaceId, 'sources'));
}

/**
 * The `BlobStore` `FsCompilationStore` (P0.4, `compilations/fs-compilation-store.ts`)
 * reads/writes for a given workspace — `<dataRootDir>/<workspaceId>/compilations`,
 * a fourth sibling of `workspacePackagesStore`/`workspaceRegistryStore`/
 * `workspaceSourcesStore` for the same reason each of those is separate
 * from the others: "compilation records and results" is a distinct
 * concern from "raw uploaded sources awaiting compilation".
 */
export function workspaceCompilationsStore(record: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, record.workspaceId, 'compilations'));
}

/** Fifth sibling — capability approval records (P0.5), `<dataRootDir>/<workspaceId>/approvals`. */
export function workspaceApprovalsStore(record: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, record.workspaceId, 'approvals'));
}

/** Sixth sibling — execution records (P0.5), `<dataRootDir>/<workspaceId>/executions`. */
export function workspaceExecutionsStore(record: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, record.workspaceId, 'executions'));
}

/** Seventh sibling — persistent workflow execution records (P0.8), `<dataRootDir>/<workspaceId>/workflow-executions`. */
export function workspaceWorkflowExecutionsStore(record: WorkspaceRecord, config: WorkspaceDataConfig): LocalFsBlobStore {
  return new LocalFsBlobStore(join(config.dataRootDir, record.workspaceId, 'workflow-executions'));
}
