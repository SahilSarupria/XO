import type { Result } from '@xo/types';
import type { NotFoundError, XoError } from '@xo/errors';

/**
 * A single workspace: the ownership boundary between an authenticated
 * identity and a server-controlled storage namespace. Nothing about
 * this record is a filesystem path — `storageKeyPrefix` is a logical
 * `BlobStore` key prefix, meaningful only in combination with whatever
 * root `BlobStore` the server itself is configured with (see
 * `fs-workspace-store.ts`). A client never supplies, sees, or can
 * influence the *actual* directory this maps to; it only ever sees this
 * record.
 */
export interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly identityId: string;
  readonly name?: string;
  readonly createdAt: string;
  /**
   * The server-owned key prefix future slices (source upload, compiled
   * package storage, execution history) will write under, e.g.
   * `workspace-data/ws_.../`. Exposed to the client as an opaque label
   * only — it is not a path on any filesystem the client can reach or
   * reason about, and nothing in this milestone writes anything under
   * it yet (no upload/compile/execution exists here — see the milestone
   * brief's strict scope section).
   */
  readonly storageKeyPrefix: string;
}

export interface CreateWorkspaceInput {
  readonly name?: string;
}

/**
 * The single authority for `workspaceId -> owning identity -> storage
 * namespace`. Every route that needs to know whether a given identity
 * may touch a given workspace goes through this interface — never
 * through a client-supplied path, and never by trusting an `identityId`
 * the request body claims (see `workspace-routes.ts`, which always
 * derives ownership from `req.identity`, never from a request body).
 */
export interface WorkspaceStore {
  /** Always mints a new, server-generated `workspaceId` — never accepts one from a caller. */
  create(identityId: string, input?: CreateWorkspaceInput): Promise<Result<WorkspaceRecord, XoError>>;

  /**
   * Looks up a workspace by id with no ownership check — callers
   * (route handlers) are responsible for comparing `record.identityId`
   * against the authenticated identity themselves. Returns
   * `NotFoundError` for any id that doesn't resolve to a record,
   * including a syntactically invalid one (see `isValidWorkspaceId`) —
   * this is deliberately "fails closed", not "throws a different error
   * for a malformed id", so a route can map every failure here straight
   * to 404 without needing to distinguish "malformed" from "unknown".
   */
  get(workspaceId: string): Promise<Result<WorkspaceRecord, NotFoundError>>;

  /** Returns only workspaces owned by `identityId` — an identity with no workspaces yet gets `ok([])`, never an error. */
  listByIdentity(identityId: string): Promise<Result<readonly WorkspaceRecord[], XoError>>;
}

/**
 * Strict allowlist for the ids this store itself mints
 * (`ws_<32 lowercase hex chars>`). Enforced both when minting (so every
 * id this store ever returns satisfies it) and, more importantly, when
 * a caller hands one back in from a URL (`GET /workspaces/:workspaceId`)
 * — this is a defense-in-depth belt on top of `LocalFsBlobStore`'s own
 * traversal guard (`resolveKey`'s `..`-segment check), not a
 * replacement for it: even if this check were somehow bypassed, the
 * underlying store still refuses to resolve a key outside its root.
 */
const WORKSPACE_ID_PATTERN = /^ws_[0-9a-f]{32}$/;

export function isValidWorkspaceId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value);
}
