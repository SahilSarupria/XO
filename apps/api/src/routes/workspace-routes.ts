import { ErrorCode, NotFoundError, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { ApiKeyIdentity } from '../auth/identity.js';
import type { WorkspaceRecord, WorkspaceStore } from '../workspace/workspace.js';

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
function toWireRecord(record: WorkspaceRecord): WorkspaceRecord {
  return record;
}

interface CreateWorkspaceBody {
  readonly name?: unknown;
  // Deliberately not typed further: any other field (e.g. an attempted
  // `identityId` override) is inert here. See parseCreateBody below.
}

function parseCreateBody(body: CreateWorkspaceBody): { readonly name?: string } {
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, '"name", if present, must be a string');
  }
  return body.name !== undefined ? { name: body.name } : {};
}

function makeHandlers(workspaceStore: WorkspaceStore) {
  async function createWorkspace(req: ApiRequest): Promise<ApiResponse> {
    const identity = requireIdentity(req);

    // A missing/empty body is fine (name is optional) — only a
    // present-but-unparseable body is a real 400.
    const raw = await req.rawBody();
    let name: string | undefined;
    if (raw.length > 0) {
      const bodyResult = await req.json<CreateWorkspaceBody>();
      if (!bodyResult.ok) throw bodyResult.error;
      name = parseCreateBody(bodyResult.value).name;
    }

    const created = await workspaceStore.create(identity.identityId, name !== undefined ? { name } : {});
    if (!created.ok) throw created.error;
    return json(201, toWireRecord(created.value));
  }

  async function listWorkspaces(req: ApiRequest): Promise<ApiResponse> {
    const identity = requireIdentity(req);
    const listed = await workspaceStore.listByIdentity(identity.identityId);
    if (!listed.ok) throw listed.error;
    return json(200, { workspaces: listed.value.map(toWireRecord) });
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
    if (found.value.identityId !== identity.identityId) {
      throw new NotFoundError(`workspace "${workspaceId}"`);
    }

    return json(200, toWireRecord(found.value));
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

export function registerWorkspaceRoutes(router: Router, workspaceStore: WorkspaceStore): void {
  const { createWorkspace, listWorkspaces, getWorkspace } = makeHandlers(workspaceStore);
  router.post('/workspaces', guarded(createWorkspace));
  router.get('/workspaces', guarded(listWorkspaces));
  router.get('/workspaces/:workspaceId', guarded(getWorkspace));
}
