import { DEVELOPMENT_TRUST_WARNING, assertTrustPolicyAllowedHere, loadOperatorTrustPolicy, type PackageTrustPolicy } from '@xo/package-sdk';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Result } from '@xo/types';
import { AuditError, ErrorCode, XoError } from '@xo/errors';
import type { Logger } from '@xo/logger';
import { LocalFsBlobStore } from '@xo/storage';
import type { ApiRequest, ApiResponse } from './http/types.js';
import { Router } from './http/router.js';
import { BodyTooLargeError, readRawBody, parseJsonBody } from './http/body.js';
import { errorToResponse } from './http/error-mapping.js';
import { writeResponse } from './http/respond.js';
import { createApiKeyAuth } from './http/auth.js';
import type { ApiKeyStore } from './auth/api-key-store.interface.js';
import { FsApiKeyStore } from './auth/fs-api-key-store.js';
import type { WorkspaceStore } from './workspace/workspace.js';
import { FsWorkspaceStore } from './workspace/fs-workspace-store.js';
import type { WorkspaceDataConfig } from './workspace/workspace-context.js';
import { loadConfig } from './config.js';
import { registerRoutes } from './routes/index.js';
import { PermissionManager, RuleBasedPolicy, type PermissionPolicy } from '@xo/permissions';
import { AuditAccessController, NonProductionAuditSink, type AuditSink } from '@xo/audit';
import { AuditService } from './audit/audit-service.js';

export interface ServerDeps {
  readonly logger?: Logger;
  /** P1.0 M5 — injected trust policy (tests/embedders). When omitted the policy is resolved from the environment by `loadOperatorTrustPolicy()`, which fails closed (startup aborts) unless a policy file or the explicit `XO_TRUST_MODE=development` is configured. */
  readonly packageTrustPolicy?: PackageTrustPolicy;
  /**
   * Injected directly when a caller already has one (e.g.
   * `test-helpers.ts`'s `TestServer`, which provisions a temp-dir-backed
   * store per test run). Takes precedence over `apiKeysDir` below when
   * both are given.
   */
  readonly apiKeyStore?: ApiKeyStore;
  /**
   * Directory to build a default `FsApiKeyStore` from when `apiKeyStore`
   * isn't supplied. Defaults to `loadConfig().apiKeysDir` (which itself
   * reads `API_KEYS_DIR`) — see `config.ts` for why this one directory
   * is server-wide config rather than a per-request query parameter.
   */
  readonly apiKeysDir?: string;
  /** Same injection seam as `apiKeyStore`, for the workspace ownership store — see `workspace/fs-workspace-store.ts`. */
  readonly workspaceStore?: WorkspaceStore;
  /** Directory to build a default `FsWorkspaceStore` from when `workspaceStore` isn't supplied. Defaults to `loadConfig().workspacesDir` (`WORKSPACES_DIR`). */
  readonly workspacesDir?: string;
  /** Root directory workspace-scoped package/registry data lives under (see `workspace/workspace-context.ts`). Defaults to `loadConfig().workspaceDataDir` (`WORKSPACE_DATA_DIR`). */
  readonly workspaceDataDir?: string;
  /**
   * P1.0 M2 — the server-side authorization policy (operator-supplied
   * `@xo/permissions` rules, optionally matching `principalId`/`principalKind`).
   * Default: `RuleBasedPolicy([])` — deny everything that declares a permission.
   * Capabilities that explicitly declare no permissions still require an
   * authenticated principal. There is no client-side input to this policy.
   */
  readonly permissionPolicy?: PermissionPolicy;
  /**
   * P1.0 M4 — the durable audit sink. REQUIRED when `NODE_ENV=production` (startup fails without it: no silent
   * unaudited or volatile operation in production). When omitted outside production, an explicit volatile
   * `NonProductionAuditSink` is used and a warning is logged.
   */
  readonly auditSink?: AuditSink;
  /** Principal kinds that may even be considered for `audit.read`/`audit.purge` (default `['service']`; the policy still decides). */
  readonly auditAccessKinds?: readonly ('human' | 'service')[];
}

function buildApiRequest(incoming: IncomingMessage, params: Readonly<Record<string, string>>, url: URL): ApiRequest {
  let cachedBody: Promise<Buffer> | undefined;
  const rawBody = (): Promise<Buffer> => {
    cachedBody ??= readRawBody(incoming);
    return cachedBody;
  };

  return {
    method: incoming.method ?? 'GET',
    path: url.pathname,
    params,
    query: url.searchParams,
    headers: incoming.headers,
    rawBody,
    rawBodyLimited: async (maxBytes: number): Promise<Buffer> => {
      cachedBody ??= readRawBody(incoming, maxBytes);
      const buffer = await cachedBody;
      if (buffer.length > maxBytes) throw new BodyTooLargeError(maxBytes);
      return buffer;
    },
    json: async <T>(): Promise<Result<T, XoError>> => {
      const buffer = await rawBody();
      return parseJsonBody<T>(buffer);
    },
  };
}

/**
 * Builds the router with every route registered, but doesn't bind a
 * socket — `createHttpServer()` below does that. Split out so tests can
 * exercise route resolution/handlers without a real listener when they
 * want to (most tests here use a real loopback listener instead, since
 * this sandbox's `node:http` loopback networking works — see
 * README.md's "Testing" section for why that's the approach taken).
 */
export function buildRouter(deps: ServerDeps = {}): Router {
  const apiKeyStore = deps.apiKeyStore ?? new FsApiKeyStore(new LocalFsBlobStore(deps.apiKeysDir ?? loadConfig().apiKeysDir));
  const workspaceStore =
    deps.workspaceStore ?? new FsWorkspaceStore(new LocalFsBlobStore(deps.workspacesDir ?? loadConfig().workspacesDir));
  // P1.0 M5: the trust configuration is operator configuration, resolved by the same function the CLI uses. A missing, unreadable, invalid or contradictory configuration aborts startup (fail closed) — it is never read as "development mode"; that exists only when asked for by name (XO_TRUST_MODE=development).
  let packageTrustPolicy = deps.packageTrustPolicy;
  if (packageTrustPolicy === undefined) {
    const loaded = loadOperatorTrustPolicy();
    if (!loaded.ok) throw loaded.error;
    packageTrustPolicy = loaded.value;
  }
  // Injected policies get the same production guard as environment-resolved ones: no entry point is the permissive one.
  const allowed = assertTrustPolicyAllowedHere(packageTrustPolicy);
  if (!allowed.ok) throw allowed.error;
  if (packageTrustPolicy.mode === 'development') {
    deps.logger?.warn(DEVELOPMENT_TRUST_WARNING);
  }
  const workspaceDataConfig: WorkspaceDataConfig = {
    dataRootDir: deps.workspaceDataDir ?? loadConfig().workspaceDataDir,
    packageTrustPolicy,
  };
  const router = new Router();
  router.use(createApiKeyAuth(apiKeyStore));
  const permissionManager = new PermissionManager({ policy: deps.permissionPolicy ?? new RuleBasedPolicy([]) });
  if (deps.auditSink === undefined && process.env['NODE_ENV'] === 'production') {
    throw new AuditError(ErrorCode.AUDIT_CONFIG_INVALID, 'a durable audit sink is required in production (see XO_AUDIT_* configuration)');
  }
  const auditSink = deps.auditSink ?? new NonProductionAuditSink();
  if (auditSink.mode === 'non-production') {
    deps.logger?.warn('AUDIT IS RUNNING IN NON-PRODUCTION MODE: audit events are volatile (process memory only) and are NOT durable');
  }
  const audit = new AuditService(auditSink, (info) => deps.logger?.error(`audit write failed (${info.phase}): ${info.code}`));
  const auditAccess = new AuditAccessController({
    permissionManager,
    ...(deps.auditAccessKinds !== undefined ? { allowedPrincipalKinds: deps.auditAccessKinds } : {}),
  });
  registerRoutes(router, { workspaceStore, workspaceDataConfig, permissionManager, audit, auditSink, auditAccess });
  return router;
}

/** Wraps a matched handler's execution so every failure — a `Result` error surfaced as a throw, or a genuinely unexpected exception — funnels through the same `errorToResponse()` mapping. Handlers themselves only ever return `ApiResponse` on success; they signal failure by throwing the `XoError`/`Error` they hit, exactly once, right here. */
async function runHandler(handler: (req: ApiRequest) => Promise<ApiResponse>, req: ApiRequest): Promise<ApiResponse> {
  try {
    return await handler(req);
  } catch (cause) {
    return errorToResponse(cause);
  }
}

export function createHttpServer(deps: ServerDeps = {}): Server {
  const router = buildRouter(deps);

  return createServer((incoming, res) => {
    void (async () => {
      try {
        const url = new URL(incoming.url ?? '/', 'http://localhost');
        const resolved = router.resolve(incoming.method ?? 'GET', url.pathname);

        if (resolved === undefined) {
          const status = router.hasPathForOtherMethod(incoming.method ?? 'GET', url.pathname) ? 405 : 404;
          const code = status === 405 ? ErrorCode.UNIMPLEMENTED : ErrorCode.NOT_FOUND;
          const message =
            status === 405
              ? `method "${incoming.method}" not supported for "${url.pathname}"`
              : `no route for "${incoming.method} ${url.pathname}"`;
          writeResponse(res, errorToResponse(new XoError(code, message)));
          return;
        }

        const apiRequest = buildApiRequest(incoming, resolved.params, url);
        const response = await runHandler(resolved.handler, apiRequest);
        writeResponse(res, response);
      } catch (cause) {
        // Anything reaching here happened outside a handler entirely
        // (e.g. malformed request line) — still funnel through the same
        // mapping rather than letting `node:http` write a bare 500.
        writeResponse(res, errorToResponse(cause));
      }
    })();
  });
}
