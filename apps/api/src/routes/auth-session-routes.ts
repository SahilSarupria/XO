import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import type { SessionAuthService } from '../auth/session/service.js';

/**
 * Sign-in → XO session endpoints. Registered only when Google sign-in is configured.
 *
 *   POST /auth/login-challenge   unauthenticated, rate limited
 *   POST /auth/session           unauthenticated, rate limited -> session, from EITHER { challengeId, idToken }
 *                                OR { challengeId, code, codeVerifier, redirectUri } (the API redeems the code with the
 *                                OAuth client secret; 501 unless the operator configured it)
 *   POST /auth/refresh           unauthenticated, rate limited: { refreshCredential } -> session
 *   POST /auth/logout            authenticated with the session's access credential; revokes ONLY that session
 *
 * (The path prefix has no `/v1`: no route in this API has one.) Request bodies are small, strictly shaped JSON
 * objects; unknown fields are ignored. None of these routes exposes binding management or any listing.
 */
const MAX_FIELD = 8192;

function clientKey(req: ApiRequest): string {
  return req.remoteAddress ?? 'unknown';
}

async function body(req: ApiRequest): Promise<Record<string, unknown>> {
  const parsed = await req.json<unknown>();
  if (!parsed.ok) throw parsed.error;
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'request body must be a JSON object');
  }
  return parsed.value as Record<string, unknown>;
}

function field(b: Record<string, unknown>, name: string): string {
  const v = b[name];
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_FIELD) {
    throw new XoError(ErrorCode.INVALID_ARGUMENT, `"${name}" must be a non-empty string`);
  }
  return v;
}

const noStore = { 'cache-control': 'no-store' };

export function registerAuthSessionRoutes(router: Router, service: SessionAuthService): void {
  router.post('/auth/login-challenge', async (req): Promise<ApiResponse> =>
    json(201, await service.createChallenge(clientKey(req)), noStore),
  );

  router.post('/auth/session', async (req): Promise<ApiResponse> => {
    const b = await body(req);
    const challengeId = field(b, 'challengeId');
    const hasToken = b['idToken'] !== undefined;
    const hasCode = b['code'] !== undefined;
    if (hasToken === hasCode) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'send exactly one of "idToken" or "code"');
    if (hasToken) return json(201, await service.exchange(clientKey(req), challengeId, field(b, 'idToken')), noStore);
    return json(
      201,
      await service.exchangeWithCode(clientKey(req), challengeId, field(b, 'code'), field(b, 'codeVerifier'), field(b, 'redirectUri')),
      noStore,
    );
  });

  router.post('/auth/refresh', async (req): Promise<ApiResponse> => {
    const b = await body(req);
    return json(200, await service.refresh(clientKey(req), field(b, 'refreshCredential')), noStore);
  });

  router.post('/auth/logout', async (req): Promise<ApiResponse> => {
    if (req.session === undefined) {
      // Authenticated, but not with an XO session credential (an API key or a provider JWT): there is no session to end.
      throw new XoError(ErrorCode.INVALID_ARGUMENT, 'logout applies only to an XO session credential');
    }
    await service.logout(req.session.familyId);
    return { status: 204, headers: noStore };
  });
}
