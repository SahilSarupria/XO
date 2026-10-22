import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { ApiKeyIdentity } from '../auth/identity.js';
import { roleOf, type WorkspaceKind, type WorkspaceRecord, type WorkspaceRole, type WorkspaceStore } from '../workspace/workspace.js';
import { isKnownRegion, regionLabel } from '../workspace/regions.js';
import { recordAudit } from '../audit/record.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';

/**
 * `identity -> workspace -> storage namespace` is the whole point of
 * this file. Every handler below derives ownership exclusively from
 * `req.identity` (set by the auth middleware, `http/auth.ts`, before
 * any handler runs) — never from anything in the request body or a URL
 * param. A request body MAY carry an optional `name`; if it also
 * carries `identityId` (or anything else claiming to say who the
 * caller is), that field is simply never read. There is no code path
 * in this file that looks at `body.identityId`.
 */

/**
 * Since every route registered here is reached only after
 * `createApiKeyAuth` middleware runs (see `auth.ts` — `/workspaces*` is
 * not in `EXEMPT_PATHS`), `req.identity` is always set by the time a
 * handler executes; this is a defensive assertion, not a real
 * authentication check of its own.
 */
function requireIdentity(req: ApiRequest): ApiKeyIdentity {
  if (req.identity === undefined) {
    throw new XoError(ErrorCode.UNKNOWN, 'internal error: workspace route reached with no resolved identity');
  }
  return req.identity;
}

/**
 * The wire shape returned to a client. Identical to `WorkspaceRecord`
 * today — kept as its own function/type rather than returning the
 * record directly so a future field on `WorkspaceRecord` that
 * shouldn't be client-visible doesn't leak by default; every field
 * currently on `WorkspaceRecord` is safe to expose (`storageKeyPrefix`
 * is an opaque logical label, never a filesystem path — see
 * `workspace.ts`'s doc comment).
 */
export interface WorkspaceWire {
  readonly workspaceId: string;
  readonly identityId: string;
  readonly name?: string;
  readonly kind: WorkspaceKind;
  readonly region?: string;
  readonly regionLabel?: string;
  /** Owner plus members. */
  readonly memberCount: number;
  /** The caller's own role in this workspace. */
  readonly role?: WorkspaceRole;
  readonly createdAt: string;
  readonly storageKeyPrefix: string;
}

/** The member list itself is served by `GET /workspaces/:id/members`; the workspace wire carries only the count and the caller's role. */
export function toWireRecord(record: WorkspaceRecord, callerIdentityId?: string): WorkspaceWire {
  const role = callerIdentityId !== undefined ? roleOf(record, callerIdentityId) : undefined;
  return {
    workspaceId: record.workspaceId,
    identityId: record.identityId,
    ...(record.name !== undefined ? { name: record.name } : {}),
    kind: record.kind ?? 'team',
    ...(record.region !== undefined ? { region: record.region, ...(regionLabel(record.region) !== undefined ? { regionLabel: regionLabel(record.region) as string } : {}) } : {}),
    memberCount: 1 + (record.members?.length ?? 0),
    ...(role !== undefined ? { role } : {}),
    createdAt: record.createdAt,
    storageKeyPrefix: record.storageKeyPrefix,
  };
}

interface CreateWorkspaceBody {
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly region?: unknown;
  // Deliberately not typed further: any other field (e.g. an attempted
  // `identityId` override) is inert here. See parseCreateBody below.
}

function parseCreateBody(body: CreateWorkspaceBody): { readonly name?: string; readonly kind?: WorkspaceKind; readonly region?: string } {
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"name", if present, must be a string');
  }
  if (body.kind !== undefined && body.kind !== 'team' && body.kind !== 'personal') {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"kind", if present, must be "team" or "personal"');
  }
  if (body.region !== undefined && !isKnownRegion(body.region)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"region", if present, must be one of the ids from GET /regions');
  }
  return {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.kind !== undefined ? { kind: body.kind } : {}),
    ...(body.region !== undefined ? { region: body.region } : {}),
  };
}

function makeHandlers(workspaceStore: WorkspaceStore, dataConfig: WorkspaceDataConfig | undefined) {
  async function createWorkspace(req: ApiRequest): Promise<ApiResponse> {
    const identity = requireIdentity(req);

    // A missing/empty body is fine (name is optional) — only a
    // present-but-unparseable body is a real 400.
    const raw = await req.rawBody();
    let parsed: { readonly name?: string; readonly kind?: WorkspaceKind; readonly region?: string } = {};
    if (raw.length > 0) {
      const bodyResult = await req.json<CreateWorkspaceBody>();
      if (!bodyResult.ok) throw bodyResult.error;
      parsed = parseCreateBody(bodyResult.value);
    }

    const created = await workspaceStore.create(identity.identityId, parsed);
    if (!created.ok) throw created.error;
    if (dataConfig !== undefined) {
      await recordAudit(req, created.value, dataConfig, {
        event: 'workspace.created',
        result: 'succeeded',
        target: { kind: 'workspace', id: created.value.workspaceId, ...(created.value.name !== undefined ? { label: created.value.name } : {}) },
      });
    }
    return json(201, toWireRecord(created.value, identity.identityId));
  }

  async function listWorkspaces(req: ApiRequest): Promise<ApiResponse> {
    const identity = requireIdentity(req);
    const listed = await workspaceStore.listByIdentity(identity.identityId);
    if (!listed.ok) throw listed.error;
    return json(200, { workspaces: listed.value.map((w) => toWireRecord(w, identity.identityId)) });
  }

  async function getWorkspace(req: ApiRequest): Promise<ApiResponse> {
    const identity = requireIdentity(req);
    const workspaceId = req.params['workspaceId'];
    if (workspaceId === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing workspace id');

    const found = await workspaceStore.get(workspaceId);
    if (!found.ok) throw found.error;

    // An identity asking for a workspace it doesn't own gets the exact
    // same response as a workspace that doesn't exist at all —
    // deliberately not a 403. Distinguishing "forbidden" from "not
    // found" here would let one identity learn that a given workspace
    // id belongs to *someone*, which is exactly the kind of
    // cross-identity leak this milestone exists to prevent. This is
    // the one place in this file ownership is actually enforced.
    if (roleOf(found.value, identity.identityId) === undefined) {
      throw new NotFoundError(`workspace "${workspaceId}"`);
    }

    return json(200, toWireRecord(found.value, identity.identityId));
  }

  return { createWorkspace, listWorkspaces, getWorkspace };
}

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

export function registerWorkspaceRoutes(router: Router, workspaceStore: WorkspaceStore, dataConfig?: WorkspaceDataConfig): void {
  const { createWorkspace, listWorkspaces, getWorkspace } = makeHandlers(workspaceStore, dataConfig);
  router.post('/workspaces', guarded(createWorkspace));
  router.get('/workspaces', guarded(listWorkspaces));
  router.get('/workspaces/:workspaceId', guarded(getWorkspace));
}
