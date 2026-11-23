import { createRequire } from 'node:module';
import { ErrorCode, XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import { createRateLimiter } from '../auth/session/rate-limiter.js';
import { requirePrincipal } from '../workspace/workspace-context.js';

/** The API's own version, from its package.json (the same file in development and in the built image). */
export const API_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

/**
 * S1-3 (plan 6.3, 6.4).
 *
 * `GET /version` (no credential, like /health): the API's version and which optional parts this instance offers, so Studio
 * can say "Studio needs XO x.y" instead of failing oddly, and does not ask for parts that are not there. Booleans only; nothing
 * about configuration values, identities or data.
 *
 * `POST /client-errors` (a signed-in person): Studio reports an uncaught error or a failed render WITHOUT content. The server
 * does not trust the client to have removed it: every field is checked, the message is reduced to a template (quoted text,
 * numbers, addresses and ids become placeholders) and capped, and the route pattern keeps only its shape. The report goes to
 * the instance log, not the audit trail, and is rate-limited per person. `XO_CLIENT_ERRORS=off` turns the route off (404).
 */
export function registerPlatformRoutes(
  router: Router,
  deps: {
    readonly logger?: Logger | undefined;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly features: {
      readonly connect: boolean;
      readonly googleSignIn: boolean;
      readonly oidc: boolean;
      readonly passwordSignIn: boolean;
    };
    readonly now?: () => number;
  },
): void {
  router.get('/version', async () => json(200, { version: API_VERSION, features: deps.features }, { 'cache-control': 'no-store' }));

  if (deps.env['XO_CLIENT_ERRORS'] === 'off') return;
  const limiter = createRateLimiter({ windowMs: 60_000, max: 20, ...(deps.now !== undefined ? { now: deps.now } : {}) });
  router.post('/client-errors', async (req: ApiRequest): Promise<ApiResponse> => {
    try {
      const principal = requirePrincipal(req);
      if (!limiter.allow(principal.id))
        return json(429, { error: { code: 'XO_RATE_LIMITED', message: 'too many error reports; try later' } });
      const body = await req.json<Record<string, unknown>>();
      if (!body.ok) throw body.error;
      const report = parseClientError(body.value);
      deps.logger?.warn('client error', { ...report });
      return json(202, { recorded: true });
    } catch (cause) {
      return errorToResponse(cause);
    }
  });
}

export interface ClientErrorReport {
  readonly kind: 'uncaught' | 'render' | 'unhandled-rejection';
  readonly message: string;
  readonly component?: string;
  readonly route?: string;
  readonly build?: string;
  readonly count: number;
}

const FIELDS = new Set(['kind', 'message', 'component', 'route', 'build', 'count']);

/** A report with no content in it, or a 400. Exported for tests. */
export function parseClientError(v: unknown): ClientErrorReport {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'body must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.has(k)) throw new XoError(ErrorCode.INVALID_ARGUMENT, `unknown field "${k}"`);
  const kind = o['kind'];
  if (kind !== 'uncaught' && kind !== 'render' && kind !== 'unhandled-rejection')
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'kind must be uncaught, render or unhandled-rejection');
  if (typeof o['message'] !== 'string') throw new XoError(ErrorCode.INVALID_ARGUMENT, 'message must be a string');
  const name = (key: string, pattern: RegExp, max: number): string | undefined => {
    const x = o[key];
    if (x === undefined) return undefined;
    if (typeof x !== 'string' || x.length > max || !pattern.test(x))
      throw new XoError(ErrorCode.INVALID_ARGUMENT, `${key} must match ${pattern.source} and be at most ${max} characters`);
    return x;
  };
  const component = name('component', /^[A-Za-z][A-Za-z0-9]*$/, 60);
  const route = name('route', /^[a-z0-9/:_-]*$/, 120);
  const build = name('build', /^[0-9A-Za-z.+-]+$/, 40);
  const count = o['count'] ?? 1;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 1000)
    throw new XoError(ErrorCode.INVALID_ARGUMENT, 'count must be an integer from 1 to 1000');
  return {
    kind,
    message: messageTemplate(o['message']),
    ...(component !== undefined ? { component } : {}),
    ...(route !== undefined ? { route: routePattern(route) } : {}),
    ...(build !== undefined ? { build } : {}),
    count: count as number,
  };
}

/** "Cannot read 'Asha' of undefined at row 12" -> "Cannot read <text> of undefined at row <n>". Capped at 160 characters. */
export function messageTemplate(message: string): string {
  return message
    .slice(0, 400)
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, '<text>')
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<address>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[a-z]{2,6}_[A-Za-z0-9]{6,}\b/g, '<id>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+(?:[.,]\d+)*/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Only the shape of a route: any segment that is not a known word becomes ":id". */
export function routePattern(route: string): string {
  return route
    .split('/')
    .map((s) => (s === '' || /^[a-z]+(?:-[a-z]+)*$/.test(s) ? s : ':id'))
    .join('/');
}
