import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { requireOwnedWorkspace, requirePermission, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceStore } from '../workspace/workspace.js';

/** Who may even be told the route is gone: the same caller the route required, so a non-member still gets 404 and a viewer 403. */
export interface RemovedStubAccess {
  readonly workspaceStore: WorkspaceStore;
  readonly dataConfig: WorkspaceDataConfig;
  readonly permission: 'read' | 'author' | 'review' | 'publish' | 'manage';
  readonly action: string;
}

/**
 * UW-12b (ADR 0052): a route of the removed composed-workflow runner. It answers `410 XO_COMPOSED_RUNNER_REMOVED` and names the route
 * that replaces it. It does nothing, but it keeps the route's authentication, workspace and permission checks, so the answer is the same
 * 401/404/403 as before for a caller who could not have used the route, and the documented permission still matches enforcement.
 */
export function registerRemovedStub(
  router: Router,
  method: 'get' | 'post',
  path: string,
  replacement: string,
  access: RemovedStubAccess,
): void {
  router.add(method.toUpperCase(), path, async (req: ApiRequest): Promise<ApiResponse> => {
    try {
      const w = await requireOwnedWorkspace(req, access.workspaceStore);
      await requirePermission(req, w, access.permission, access.dataConfig, { action: access.action });
    } catch (cause) {
      return errorToResponse(cause);
    }
    return errorToResponse(
      new XoError(ErrorCode.COMPOSED_RUNNER_REMOVED, `the composed-workflow runner was removed (ADR 0052). Use ${replacement} instead.`, {
        context: { replacement, removedPath: path },
      }),
    );
  });
}
