import { AuthError, ErrorCode } from '@xo/errors';
import { Sha256Hasher } from '@xo/crypto';
import type { ApiKeyStore } from '../auth/api-key-store.interface.js';
import { hashApiKey } from '../auth/api-key.js';
import type { ApiRequest, Middleware } from './types.js';

/**
 * Real API key authentication, replacing the old `passThroughAuth`
 * no-op. `server.ts`'s `buildRouter()` registers exactly one instance of
 * this via `router.use(...)` — nothing about routing, error-mapping, or
 * any individual route handler changed shape to make this drop-in
 * possible, per the seam `passThroughAuth`'s own doc comment described.
 *
 * Scheme: `Authorization: Bearer <key>` — the conventional HTTP bearer
 * scheme (RFC 6750-ish), the same header shape Stripe/GitHub/most
 * API-key-authenticated HTTP services use, and the obvious choice over
 * a custom header (`X-Api-Key` etc.) when there's no reason to deviate.
 *
 * What this file deliberately does NOT do: decide what an authenticated
 * caller is *allowed* to do. That's `@xo/permissions`' job, entirely
 * out of scope here — see `apps/api/README.md`'s "Auth" section for the
 * full auth/permissions boundary reasoning. This middleware answers
 * exactly one question — is there a valid, non-revoked API key on this
 * request, and if so, what identity does it resolve to — and either
 * throws an `AuthError` (funneled through `error-mapping.ts` by
 * `server.ts`'s `runHandler`, same as every other route-level failure)
 * or attaches `req.identity` and calls `next()`.
 */

/**
 * Routes reachable with no credential at all. Kept intentionally short
 * and explicit (an allowlist, not a denylist) — anything not listed here
 * requires a valid key, so a new route added later is auth-protected by
 * default rather than accidentally public. `/health` stays open for
 * uptime monitors/orchestrators that shouldn't need a key just to check
 * liveness; `/openapi.json` stays open because the machine-readable API
 * doc describing how to authenticate has to be readable before you have
 * credentials to authenticate with.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set(['/health', '/openapi.json']);

function extractBearerToken(req: ApiRequest): string | undefined {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(value.trim());
  return match?.[1];
}

/**
 * Builds the auth `Middleware` against a given `ApiKeyStore`. Not a
 * singleton/module-level instance (unlike the old `passThroughAuth`)
 * because the store itself needs to be constructed from config
 * (`API_KEYS_DIR` — see `config.ts`) or injected by a test
 * (`test-helpers.ts`'s `TestServer`); `server.ts`'s `buildRouter()` is
 * the one call site that decides which store a given process uses.
 */
export function createApiKeyAuth(store: ApiKeyStore): Middleware {
  const hasher = new Sha256Hasher();

  return async (req, next) => {
    if (EXEMPT_PATHS.has(req.path)) return next();

    const token = extractBearerToken(req);
    if (token === undefined || token.length === 0) {
      throw new AuthError(ErrorCode.AUTH_KEY_MISSING, 'missing or malformed "Authorization: Bearer <key>" header');
    }

    const found = await store.findByHash(hashApiKey(token, hasher));
    if (!found.ok) {
      throw new AuthError(ErrorCode.AUTH_KEY_INVALID, 'API key is not recognized');
    }
    if (found.value.revokedAt !== undefined) {
      throw new AuthError(ErrorCode.AUTH_KEY_REVOKED, 'API key has been revoked');
    }

    req.identity = found.value.creatorDid !== undefined ? { identityId: found.value.identityId, creatorDid: found.value.creatorDid } : { identityId: found.value.identityId };
    return next();
  };
}
