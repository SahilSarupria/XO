import { AuthError, ErrorCode } from '@xo/errors';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
import { Sha256Hasher } from '@xo/crypto';
import type { ApiKeyStore } from '../auth/api-key-store.interface.js';
import { hashApiKey } from '../auth/api-key.js';
import { looksLikeJwt, type AccessTokenVerifier } from '../auth/oidc/verifier.js';
import type { IdentityBindingStore } from '../auth/oidc/binding-store.interface.js';
import { ACCESS_PREFIX, type FsSessionStore } from '../auth/session/session-store.js';
import { SESSION_PUBLIC_PATHS } from '../auth/session/paths.js';
import type { SessionGate } from '../auth/session/gate.js';
import { enforceGate } from '../auth/session/lifecycle.js';
import type { ApiRequest, Middleware } from './types.js';

/**
 * Authentication, replacing the old `passThroughAuth` no-op. `server.ts`'s
 * `buildRouter()` registers exactly one instance via `router.use(...)`.
 *
 * Two SEPARATE credential mechanisms, dispatched on the credential's shape
 * and never cross-interpreted:
 *
 *  1. API keys — `Authorization: Bearer xoak_…`. Looked up by hash in the
 *     `ApiKeyStore`. Unchanged behaviour. A token starting `xoak_` can only
 *     ever be an API key; it is never offered to the JWT verifier.
 *  2. OIDC access tokens — only when OIDC is configured. A bearer token that
 *     is NOT `xoak_`-prefixed and is shaped like a JWT is verified against the
 *     configured issuer/JWKS, then `(iss, sub)` is resolved through the
 *     server-side `IdentityBindingStore`. A valid token with no active binding
 *     is rejected (401), never auto-provisioned. When OIDC is not configured,
 *     JWT-shaped tokens get exactly the pre-existing "API key is not
 *     recognized" answer.
 *
 * Either way the result is the same canonical `AuthenticatedPrincipal`
 * (`establishAuthenticatedPrincipal`, kind/id/orgId from a SERVER-SIDE
 * record) attached to `req.principal` / `req.identity`. No header, query
 * parameter, body field or token claim is ever consulted for identity,
 * organization, role or permission.
 *
 * What this file deliberately does NOT do: decide what an authenticated
 * caller is *allowed* to do. That's `@xo/permissions`' job — a valid identity
 * grants nothing by itself. See `apps/api/README.md`'s "Auth" section.
 */

/**
 * Routes reachable with no credential at all. An allowlist, not a denylist —
 * anything not listed requires authentication, so a new route is protected by
 * default.
 */
const EXEMPT_PATHS: ReadonlySet<string> = new Set(['/health', '/openapi.json', ...SESSION_PUBLIC_PATHS]);

const API_KEY_PREFIX = 'xoak_';

function extractBearerToken(req: ApiRequest): string | undefined {
  const header = req.headers['authorization'];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/.exec(value.trim());
  return match?.[1];
}

export interface OidcAuthDeps {
  readonly verifier: AccessTokenVerifier;
  readonly bindings: IdentityBindingStore;
}

export interface SessionAuthDeps {
  readonly store: FsSessionStore;
  readonly bindings: IdentityBindingStore;
  /** Method-specific liveness check run after the binding check on every request (password sessions). */
  readonly gate?: SessionGate;
}

export interface AuthDeps {
  readonly apiKeyStore: ApiKeyStore;
  /** Absent => `xoas_` credentials are not recognised (they fall to the API-key path and are refused as unknown keys). */
  readonly sessions?: SessionAuthDeps;
  /** Absent => OIDC acceptance is off (the fail-closed default). */
  readonly oidc?: OidcAuthDeps;
  /** Extra unauthenticated paths, present only when a feature that registers them is enabled (so a disabled feature leaves the exempt set — and every response — unchanged). */
  readonly extraPublicPaths?: readonly string[];
}

async function authenticateApiKey(req: ApiRequest, token: string, store: ApiKeyStore, hasher: Sha256Hasher): Promise<void> {
  const found = await store.findByHash(hashApiKey(token, hasher));
  if (!found.ok) {
    throw new AuthError(ErrorCode.AUTH_KEY_INVALID, 'API key is not recognized');
  }
  if (found.value.revokedAt !== undefined) {
    throw new AuthError(ErrorCode.AUTH_KEY_REVOKED, 'API key has been revoked');
  }

  // P1.0 M1: the principal is derived ONLY from the server-side key
  // record. No header, query parameter or body field is ever consulted
  // for identity, and a record without a valid principal binding fails
  // closed (no default / fabricated principal). The message names no
  // key material.
  const principal = establishAuthenticatedPrincipal({
    kind: found.value.principalKind,
    id: found.value.identityId,
    ...(found.value.orgId !== undefined ? { orgId: found.value.orgId } : {}),
  });
  if (!principal.ok) {
    throw new AuthError(ErrorCode.AUTH_KEY_INVALID, 'API key is not bound to a valid principal (re-issue the key with a principal kind)');
  }
  req.principal = principal.value;
  req.identity =
    found.value.creatorDid !== undefined
      ? { identityId: found.value.identityId, creatorDid: found.value.creatorDid }
      : { identityId: found.value.identityId };
  req.authentication = { credential: 'api-key' };
}

const UNBOUND_MESSAGE = 'this sign-in is not authorized for XO';

async function authenticateOidc(req: ApiRequest, token: string, oidc: OidcAuthDeps): Promise<void> {
  // Throws AuthError (TOKEN_INVALID / TOKEN_EXPIRED / PROVIDER_UNAVAILABLE) — before any binding lookup.
  const verified = await oidc.verifier.verify(token);

  const found = await oidc.bindings.find(verified.issuer, verified.subject);
  if (!found.ok) {
    // The binding store itself failed: we cannot establish who this is, so refuse (fail closed).
    throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be verified right now; try again shortly');
  }
  const binding = found.value;
  // No record, a corrupt record and a revoked record are indistinguishable to the caller.
  if (binding === undefined || binding.revokedAt !== undefined) throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);

  const principal = establishAuthenticatedPrincipal({
    kind: binding.principalKind,
    id: binding.identityId,
    ...(binding.orgId !== undefined ? { orgId: binding.orgId } : {}),
  });
  if (!principal.ok) throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);

  req.principal = principal.value;
  req.identity = { identityId: binding.identityId };
  req.authentication = { credential: 'oidc', issuer: verified.issuer };
}

async function authenticateSession(req: ApiRequest, token: string, sessions: SessionAuthDeps): Promise<void> {
  let result;
  let found;
  try {
    result = await sessions.store.authenticate(token);
    if (!result.ok) {
      throw result.reason === 'expired'
        ? new AuthError(ErrorCode.AUTH_TOKEN_EXPIRED, 'session access credential has expired; refresh it')
        : new AuthError(ErrorCode.AUTH_TOKEN_INVALID, 'session credential is not valid');
    }
    found = await sessions.bindings.find(result.session.issuer, result.session.subject);
  } catch (cause) {
    if (cause instanceof AuthError) throw cause;
    // The session or binding store failed: identity cannot be established, so refuse (fail closed).
    throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be verified right now; try again shortly');
  }
  if (!found.ok) throw new AuthError(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, 'sign-in cannot be verified right now; try again shortly');
  const binding = found.value;
  // The principal is re-derived from the binding on EVERY request: revoking the binding ends the session's access at once.
  if (binding === undefined || binding.revokedAt !== undefined) {
    // End the session for good, so re-binding the same identity later does not silently revive old credentials.
    await sessions.store.revoke(result.session.familyId, 'binding-revoked').catch(() => undefined);
    throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);
  }
  const principal = establishAuthenticatedPrincipal({
    kind: binding.principalKind,
    id: binding.identityId,
    ...(binding.orgId !== undefined ? { orgId: binding.orgId } : {}),
  });
  if (!principal.ok) throw new AuthError(ErrorCode.AUTH_IDENTITY_UNBOUND, UNBOUND_MESSAGE);

  // Method-specific liveness (e.g. a password session whose password changed or whose account was disabled).
  if (sessions.gate !== undefined) await enforceGate(sessions.gate, sessions.store, result.session);

  req.principal = principal.value;
  req.identity = { identityId: binding.identityId };
  req.authentication = { credential: 'session', issuer: result.session.issuer };
  req.session = { familyId: result.session.familyId };
}

/** Builds the auth `Middleware`. Not a singleton: stores are constructed from config or injected by tests. */
export function createAuthMiddleware(deps: AuthDeps): Middleware {
  const hasher = new Sha256Hasher();
  const exempt = deps.extraPublicPaths === undefined ? EXEMPT_PATHS : new Set([...EXEMPT_PATHS, ...deps.extraPublicPaths]);

  return async (req, next) => {
    if (exempt.has(req.path)) return next();

    const token = extractBearerToken(req);
    if (token === undefined || token.length === 0) {
      throw new AuthError(ErrorCode.AUTH_KEY_MISSING, 'missing or malformed "Authorization: Bearer <key>" header');
    }

    if (deps.sessions !== undefined && token.startsWith(ACCESS_PREFIX)) {
      await authenticateSession(req, token, deps.sessions);
    } else if (deps.oidc !== undefined && !token.startsWith(API_KEY_PREFIX) && looksLikeJwt(token)) {
      await authenticateOidc(req, token, deps.oidc);
    } else {
      await authenticateApiKey(req, token, deps.apiKeyStore, hasher);
    }
    return next();
  };
}

/** API-key-only authentication (OIDC off). Kept as the stable name existing callers use. */
export function createApiKeyAuth(store: ApiKeyStore): Middleware {
  return createAuthMiddleware({ apiKeyStore: store });
}
