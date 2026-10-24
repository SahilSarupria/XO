import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import type { PasswordAuthService } from '../auth/password/service.js';
import type { SessionLifecycle } from '../auth/session/lifecycle.js';

/**
 * Password sign-in endpoints. Registered ONLY when `XO_API_PASSWORD_AUTH=1`; with it unset none of these paths exist
 * (404) and the unauthenticated-path list is unchanged.
 *
 *   POST /auth/password/login    unauthenticated: { loginName, password } -> session. ONE generic 401 for every failure.
 *   POST /auth/password/setup    unauthenticated: { token, newPassword }  -> 200. Redeems a single-use setup/reset token.
 *   POST /auth/password/change   authenticated by a PASSWORD session: { currentPassword, newPassword } -> a fresh session.
 *
 * There is no registration route and no "forgot password" route: accounts and recovery tokens are issued by an
 * operator (`scripts/manage-password-accounts.ts`). Bodies are never logged anywhere in this server; responses are
 * `Cache-Control: no-store`.
 */
const noStore = { 'cache-control': 'no-store' };
const MAX_BODY_FIELD = 4096;

function clientKey(req: ApiRequest): string {
  return req.remoteAddress ?? 'unknown';
}

async function body(req: ApiRequest): Promise<Record<string, unknown>> {
  const parsed = await req.json<unknown>();
  if (!parsed.ok) throw parsed.error;
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body must be a JSON object');
  }
  const b = parsed.value as Record<string, unknown>;
  for (const v of Object.values(b))
    if (typeof v === 'string' && v.length > MAX_BODY_FIELD) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'a field is too long');
  return b;
}

export const PASSWORD_PUBLIC_PATHS: readonly string[] = ['/auth/password/login', '/auth/password/setup'];

export function registerPasswordAuthRoutes(router: Router, service: PasswordAuthService): void {
  router.post('/auth/password/login', async (req): Promise<ApiResponse> => {
    const b = await body(req);
    return json(201, await service.login(clientKey(req), b['loginName'], b['password']), noStore);
  });

  router.post('/auth/password/setup', async (req): Promise<ApiResponse> => {
    const b = await body(req);
    await service.redeemToken(clientKey(req), b['token'], b['newPassword']);
    return json(200, { passwordSet: true, next: 'sign in with your login name and the new password' }, noStore);
  });

  router.post('/auth/password/change', async (req): Promise<ApiResponse> => {
    if (req.session === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'a password can be changed only from a password session');
    const b = await body(req);
    return json(200, await service.changePassword(clientKey(req), req.session.familyId, b['currentPassword'], b['newPassword']), noStore);
  });
}

/** `/auth/refresh` and `/auth/logout` for deployments with password sign-in but no Google sign-in (same routes, same behaviour). */
export function registerSessionLifecycleRoutes(router: Router, lifecycle: SessionLifecycle): void {
  router.post('/auth/refresh', async (req): Promise<ApiResponse> => {
    const b = await body(req);
    const credential = b['refreshCredential'];
    if (typeof credential !== 'string' || credential.length === 0)
      throw new XoError(ErrorCode.INVALID_ARGUMENT, '"refreshCredential" must be a non-empty string');
    return json(200, await lifecycle.refresh(clientKey(req), credential), noStore);
  });

  router.post('/auth/logout', async (req): Promise<ApiResponse> => {
    if (req.session === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'logout applies only to an XO session credential');
    await lifecycle.logout(req.session.familyId);
    return { status: 204, headers: noStore };
  });
}
