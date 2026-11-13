import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
import type { AuthenticatedPrincipal, PermissionManager } from '@xo/permissions';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { ApiKeyIdentity } from '../auth/identity.js';

/**
 * What a route handler actually receives. Deliberately not the raw
 * `node:http` `IncomingMessage` — handlers never touch sockets or
 * streams directly, matching the CLI's `commands/*` functions never
 * touching `process.argv` directly (see `apps/cli/src/arg-parser.ts` +
 * `command-registry.ts`'s own split). `router.ts` is the one place that
 * builds this from a real request.
 */
export interface ApiRequest {
  readonly method: string;
  /** Path only, no query string — see `query` below. */
  readonly path: string;
  /** Populated by the router from `:param` segments in the matched route. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly headers: IncomingHttpHeaders;

  /** The TCP peer address, for per-client rate limiting. Behind a reverse proxy this is the proxy's address (forwarding headers are not trusted). */
  readonly remoteAddress?: string;
  /** Raw body bytes, read once and cached — safe to call more than once. */
  readonly rawBody: () => Promise<Buffer>;
  /**
   * Like `rawBody`, but enforces a ROUTE-SPECIFIC byte cap while reading (P1.1 M2: procedure bodies). Optional so request
   * doubles that predate it keep compiling; handlers fall back to `rawBody()` plus a length check. Throws `BodyTooLargeError`.
   */
  readonly rawBodyLimited?: (maxBytes: number) => Promise<Buffer>;
  /**
   * Parses the body as JSON. Returns a `Result` rather than throwing —
   * a malformed body is exactly the kind of "expected failure mode"
   * `@xo/types`' `Result` doc comment describes, not a programmer error.
   */
  readonly json: <T = unknown>() => Promise<Result<T, XoError>>;

  /**
   * Resolved by the auth middleware (`auth.ts`) before any route handler
   * runs; stays `undefined` only for routes explicitly exempt from auth
   * (see `EXEMPT_PATHS` in `auth.ts` — currently `/health` and
   * `/openapi.json`). Deliberately the one *not*-`readonly` field here:
   * `router.ts`'s `composeMiddleware` passes the same `ApiRequest` object
   * reference through every middleware and into the handler, so auth
   * attaches identity by setting this field in place rather than
   * constructing a new request for downstream code to receive.
   */
  identity?: ApiKeyIdentity;

  /**
   * P1.0 M1 — the authenticated initiating principal, set by the same
   * auth middleware, from the same server-side key record, as `identity`
   * (`principal.id === identity.identityId` always). Present on every
   * authenticated request; absent only on auth-exempt routes. Never
   * derived from request data.
   */
  principal?: AuthenticatedPrincipal;

  /**
   * UW-1 (ADR 0010) — the instance's single authorization point, attached by `buildRouter` to every request. Route code asks it through
   * `requirePermission`; it is never derived from request data.
   */
  permissionManager?: PermissionManager;

  /** UW-1 — the server's workspace data configuration, attached by `buildRouter` so a denial anywhere can be written to the workspace audit log. */
  workspaceDataConfig?: WorkspaceDataConfig;
  /** UW-1 — step-up window for approvals and membership changes, in minutes (0 = off). Attached by the server; never request data. */
  stepUpMaxAgeMinutes?: number;

  /**
   * Which kind of credential authenticated this request. Informational (log /
   * audit context); NEVER an input to authorization. For `oidc`, `issuer` is
   * the verified issuer — the bearer token itself is not retained anywhere.
   */
  authentication?: AuthenticationInfo;

  /** Set only when the request authenticated with an XO session credential: which session family it belongs to (used by logout to revoke exactly this session). */
  session?: { readonly familyId: string };
}

/**
 * `authenticatedAt` (UW-1 step-up) is when the person last proved who they are: the session's sign-in time, or the OIDC token's
 * `auth_time`. Absent when the credential does not say; then a step-up check treats the sign-in as not recent.
 */
export type AuthenticationInfo =
  | { readonly credential: 'api-key' }
  | { readonly credential: 'oidc'; readonly issuer: string; readonly authenticatedAt?: string }
  | { readonly credential: 'session'; readonly issuer: string; readonly authenticatedAt?: string };

/**
 * What a route handler returns. `body` is JSON-serialized by the
 * responder unless it's already a `Buffer`/`Uint8Array` (for the one
 * binary-download-shaped case, package archives) — see `respond.ts`.
 */
export interface ApiResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type RouteHandler = (req: ApiRequest) => Promise<ApiResponse>;

/** The seam a real auth layer drops into later — see `auth.ts`. */
export type Middleware = (req: ApiRequest, next: () => Promise<ApiResponse>) => Promise<ApiResponse>;

export function json(status: number, body?: unknown, headers?: Readonly<Record<string, string>>): ApiResponse {
  return headers !== undefined ? { status, body, headers } : { status, body };
}

/** Internal shape the router builds around a real `IncomingMessage`; not part of the handler-facing surface. */
export interface RawRequestSource {
  readonly incoming: IncomingMessage;
}
