import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Result } from '@xo/types';
import type { XoError } from '@xo/errors';
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
  /** Raw body bytes, read once and cached — safe to call more than once. */
  readonly rawBody: () => Promise<Buffer>;
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
}

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
