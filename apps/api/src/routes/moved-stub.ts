import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { ApiResponse } from '../http/types.js';

/**
 * Registers a legacy (pre-P0.2) route path that used to accept an
 * arbitrary client-supplied `?store=`/`?registry=` filesystem path.
 * Rather than leaving the path unregistered (a bare, generic "no route
 * matched" 404 that gives an integrator no clue *why*) or, far worse,
 * silently ignoring the now-removed query parameter and falling back to
 * some default/shared storage location, this always returns a clear
 * 400 naming the workspace-scoped replacement path — "a clear
 * structured client error rather than silently using an unsafe
 * fallback", per the milestone brief.
 */
export function registerMovedStub(router: Router, method: 'get' | 'post', path: string, replacementPath: string): void {
  router.add(method.toUpperCase(), path, async (): Promise<ApiResponse> =>
    errorToResponse(
      new XoError(
        ErrorCode.INVALID_ARGUMENT,
        `this endpoint no longer accepts a client-supplied "store"/"registry" path. Use the workspace-scoped equivalent instead: ${method.toUpperCase()} ${replacementPath}`,
        { context: { legacyPath: path, replacementPath } },
      ),
    ),
  );
}
