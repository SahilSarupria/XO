import { DEVELOPMENT_TRUST_WARNING, assertTrustPolicyAllowedHere, loadOperatorTrustPolicy, type PackageTrustPolicy } from '@xo/package-sdk';
import { resolve } from 'node:path';
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
import { createAuthMiddleware, type OidcAuthDeps } from './http/auth.js';
import type { ApiKeyStore } from './auth/api-key-store.interface.js';
import { FsApiKeyStore } from './auth/fs-api-key-store.js';
import type { WorkspaceStore } from './workspace/workspace.js';
import { FsWorkspaceStore } from './workspace/fs-workspace-store.js';
import type { WorkspaceDataConfig } from './workspace/workspace-context.js';
import { loadConfig } from './config.js';
import type { ConnectService } from '@xo/connect';
import { PermissionManager, RuleBasedPolicy, type PermissionPolicy } from '@xo/permissions';
import { AuditAccessController, NonProductionAuditSink, type AuditSink } from '@xo/audit';
import { EI_AUDIT_EXTENSION_SCHEMAS, createConnectRuntime, type ConnectRuntime } from '@xo/connect';
import { establishAuthenticatedPrincipal } from '@xo/permissions';
import { join } from 'node:path';
import { AuditService } from './audit/audit-service.js';
import type { ExternalToolWiring } from '@xo/runtime';

import { loadOidcConfig } from './auth/oidc/config.js';
import { createOidcVerifier } from './auth/oidc/verifier.js';
import { parseTrustedProxyHops, resolveClientAddress } from './http/client-address.js';
import { createSessionAuth, loadSessionAuthConfig, type SessionAuthBundle, type SessionAuthOptions } from './auth/session/index.js';
import { loadPasswordAuthConfig } from './auth/password/config.js';
import {
  createPasswordOnlySessionStores,
  createPasswordService,
  createPasswordStores,
  type PasswordAuthBundle,
  type PasswordAuthOptions,
} from './auth/password/bundle.js';
import { SessionLifecycle } from './auth/session/lifecycle.js';
import { createRateLimiter } from './auth/session/rate-limiter.js';
import type { SessionGate } from './auth/session/gate.js';
import { PASSWORD_PUBLIC_PATHS, registerPasswordAuthRoutes, registerSessionLifecycleRoutes } from './routes/auth-password-routes.js';
import { registerAuthSessionRoutes } from './routes/auth-session-routes.js';
import { FsIdentityBindingStore } from './auth/oidc/fs-binding-store.js';
import type { IdentityBindingStore } from './auth/oidc/binding-store.interface.js';
import type { FsSessionStore } from './auth/session/session-store.js';
import { registerRoutes, type RegisterRoutesDeps } from './routes/index.js';

export interface ServerDeps {
  readonly logger?: Logger;
  /** P1.0 M5 — injected trust policy (tests/embedders). When omitted the policy is resolved from the environment by `loadOperatorTrustPolicy()`, which fails closed (startup aborts) unless a policy file or the explicit development mode is configured. */
  readonly packageTrustPolicy?: PackageTrustPolicy;
  /** Test seam: replaces the DNS lookup / HTTPS transport the URL importer uses. Production leaves this unset. */
  readonly importFetch?: RegisterRoutesDeps['importFetch'];
  /** Test seam: replaces how chat turns a provider id into a model provider. */
  readonly chatProviderFactory?: RegisterRoutesDeps['chatProviderFactory'];
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
  /** P1.1 M3 closeout (D2): per-step procedure timeout in ms. Omitted -> `XO_PROCEDURE_STEP_TIMEOUT_MS`; unset there too -> NO timeout (no default). */
  readonly procedureStepTimeoutMs?: number;
  /** TEST-ONLY (D2): delay-only hook awaited inside the timed step work; see ProcedureRunnerContext. */
  readonly testBeforeStepExecute?: () => Promise<void>;
  /** P1.1 M4: explicit host-owned external_tool adapter wiring (programmatic only: no env var, HTTP or manifest path sets it). Absent => external_tool steps cannot execute. */
  readonly externalTools?: ExternalToolWiring;
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
  /** C7 — optional Connect application service (see `@xo/connect`). Supplied by the host's composition root. */
  readonly connect?: ConnectService;
  /**
   * C7 — when set (and no `connect` is supplied) the server builds the Connect service itself, from ITS permission manager and ITS audit
   * sink, with Connect's durable state in this directory. A host-supplied `auditSink` MUST have been created with
   * `EI_AUDIT_EXTENSION_SCHEMAS` (exported by `@xo/connect`), or every Connect operation fails closed.
   */
  readonly connectStateDir?: string;
  /**
   * The service principal Connect's durable state runs as (default `xo-connect`). The policy MUST allow it `audit.read`: starting the
   * durable store needs a single-use audit read grant for it, and without one every Connect operation fails closed.
   */
  /**
   * Let Connect read folders on THIS machine (default false). Enable only for a single-machine deployment where the API runs next to the
   * user's folders (self-hosted desktop, development). A hosted API must leave it off: it cannot see a user's computer and must not let
   * users point it at paths on the server.
   */
  readonly connectLocalFolders?: boolean;
  readonly connectServiceId?: string;
  /** Receives the Connect runtime built from `connectStateDir`, so the host can `await runtime.close()` at shutdown. */
  readonly onConnectRuntime?: (runtime: ConnectRuntime) => void;
  /**
   * OIDC bearer-token authentication, injected directly (tests, embedding). When
   * absent, it is built from `env` (`XO_API_OIDC_*`, see `auth/oidc/config.ts`):
   * unset => OIDC off (API keys only); partially or invalidly set => this
   * function THROWS, so the process fails to start rather than running with
   * weaker authentication than configured.
   */
  readonly oidc?: OidcAuthDeps;
  /**
   * Google sign-in → XO sessions. Injected by tests; in production it is built from the environment
   * (`XO_API_GOOGLE_CLIENT_ID`, see `auth/session/config.ts`) and is off when that is unset.
   */
  readonly sessionAuth?: SessionAuthBundle;
  /** Test-only tuning for the environment-built session auth (clocks, limits, key-fetch timing). */
  readonly sessionAuthOptions?: SessionAuthOptions;
  /** Test-only tuning for password sign-in (injected clock / limiter). Password sign-in itself is enabled by `XO_API_PASSWORD_AUTH=1` in `env`. */
  readonly passwordAuthOptions?: PasswordAuthOptions;
  /** Environment OIDC configuration is read from. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function buildApiRequest(
  incoming: IncomingMessage,
  params: Readonly<Record<string, string>>,
  url: URL,
  trustedProxyHops: number,
): ApiRequest {
  let cachedBody: Promise<Buffer> | undefined;
  const clientAddress = resolveClientAddress(incoming.socket.remoteAddress, incoming.headers['x-forwarded-for'], trustedProxyHops);
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
    ...(clientAddress !== undefined ? { remoteAddress: clientAddress } : {}),
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

function buildSessionAuthFromEnv(deps: ServerDeps, gate?: SessionGate): SessionAuthBundle | undefined {
  const config = loadSessionAuthConfig(deps.env ?? process.env); // throws on invalid/incomplete configuration
  if (config === undefined) return undefined;
  deps.logger?.info(`Google sign-in enabled (issuer ${config.issuer}); XO sessions stored under the configured sessions directory`);
  return createSessionAuth(config, { ...deps.sessionAuthOptions, ...(gate !== undefined ? { gate } : {}) });
}

function buildOidcFromEnv(deps: ServerDeps): OidcAuthDeps | undefined {
  const config = loadOidcConfig(deps.env ?? process.env); // throws on invalid/incomplete configuration
  if (config === undefined) return undefined;
  deps.logger?.info(`OIDC bearer authentication enabled for issuer ${config.issuer} (audience ${config.audience})`);
  return {
    verifier: createOidcVerifier(config),
    bindings: new FsIdentityBindingStore(config.bindingsDir),
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
  // P1.1 M4: consequential external effects may never run over volatile dispatch evidence in production. Checked FIRST so no other
  // configuration can mask it; `ledgerDurability` is derived from the ledger itself, never from a flag the host could set independently.
  if (deps.externalTools !== undefined && process.env['NODE_ENV'] === 'production' && deps.externalTools.ledgerDurability !== 'durable') {
    throw new XoError(
      ErrorCode.CONFIG_INVALID_VALUE,
      'external tools require a durable dispatch-evidence ledger in production (see createDurableExternalToolWiring); startup aborted',
    );
  }
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
  const oidc = deps.oidc ?? buildOidcFromEnv(deps);
  const router = new Router();
  // Password sign-in (off unless XO_API_PASSWORD_AUTH=1). Its stores and session gate come first: the gate must be
  // handed to the session layer before that layer's stores are built.
  const passwordConfig = loadPasswordAuthConfig(deps.env ?? process.env); // throws on invalid/partial configuration
  const passwordStores = passwordConfig !== undefined ? createPasswordStores(passwordConfig, deps.passwordAuthOptions) : undefined;
  const gate = passwordStores?.gate;
  if (passwordConfig !== undefined && deps.sessionAuth === undefined) {
    // Both sign-in methods share ONE session store and ONE binding store; a mismatch would silently strand password accounts.
    const google = loadSessionAuthConfig(deps.env ?? process.env);
    if (
      google !== undefined &&
      (resolve(google.sessionsDir) !== resolve(passwordConfig.sessionsDir) ||
        resolve(google.bindingsDir) !== resolve(passwordConfig.bindingsDir))
    ) {
      throw new XoError(
        ErrorCode.CONFIG_INVALID_VALUE,
        'XO_API_PASSWORD_SESSIONS_DIR and XO_API_PASSWORD_BINDINGS_DIR must name the same directories as XO_API_SESSIONS_DIR and XO_API_OIDC_BINDINGS_DIR when Google and password sign-in are both enabled',
      );
    }
  }

  const sessionAuth = deps.sessionAuth ?? buildSessionAuthFromEnv(deps, gate);
  // One session store and one binding store however a person signs in: Google's when it is configured, else password-only ones.
  let passwordSessions: { sessions: FsSessionStore; bindings: IdentityBindingStore } | undefined;
  let passwordBundle: PasswordAuthBundle | undefined;
  if (passwordConfig !== undefined && passwordStores !== undefined) {
    passwordSessions =
      sessionAuth !== undefined
        ? { sessions: sessionAuth.sessions, bindings: sessionAuth.bindings }
        : createPasswordOnlySessionStores(passwordConfig);
    passwordBundle = createPasswordService(passwordStores, passwordSessions, deps.passwordAuthOptions);
    deps.logger?.info(
      'Password sign-in enabled: accounts are operator-created, there is no self-registration, and recovery is operator-assisted',
    );
  }
  const sessionsForAuth = sessionAuth ?? passwordSessions;
  router.use(
    createAuthMiddleware({
      apiKeyStore,
      ...(oidc !== undefined ? { oidc } : {}),
      ...(sessionsForAuth !== undefined
        ? { sessions: { store: sessionsForAuth.sessions, bindings: sessionsForAuth.bindings, ...(gate !== undefined ? { gate } : {}) } }
        : {}),
      ...(passwordBundle !== undefined ? { extraPublicPaths: PASSWORD_PUBLIC_PATHS } : {}),
    }),
  );
  const permissionManager = new PermissionManager({ policy: deps.permissionPolicy ?? new RuleBasedPolicy([]) });
  if (deps.auditSink === undefined && process.env['NODE_ENV'] === 'production') {
    throw new AuditError(ErrorCode.AUDIT_CONFIG_INVALID, 'a durable audit sink is required in production (see XO_AUDIT_* configuration)');
  }
  const auditSink = deps.auditSink ?? new NonProductionAuditSink(undefined, { extensionSchemas: EI_AUDIT_EXTENSION_SCHEMAS });
  if (auditSink.mode === 'non-production') {
    deps.logger?.warn('AUDIT IS RUNNING IN NON-PRODUCTION MODE: audit events are volatile (process memory only) and are NOT durable');
  }
  const audit = new AuditService(auditSink, (info) => deps.logger?.error(`audit write failed (${info.phase}): ${info.code}`));
  const auditAccess = new AuditAccessController({
    permissionManager,
    ...(deps.auditAccessKinds !== undefined ? { allowedPrincipalKinds: deps.auditAccessKinds } : {}),
  });
  const procedureStepTimeoutMs = deps.procedureStepTimeoutMs ?? loadConfig().procedureStepTimeoutMs;
  let connect = deps.connect;
  if (connect === undefined && deps.connectStateDir !== undefined) {
    const svc = establishAuthenticatedPrincipal({ kind: 'service', id: deps.connectServiceId ?? 'xo-connect' });
    if (!svc.ok) throw svc.error;
    const runtime = createConnectRuntime({
      permissionManager,
      auditSink,
      stateDir: join(deps.connectStateDir, 'connect'),
      localFolders: deps.connectLocalFolders === true,
      durable: {
        dir: join(deps.connectStateDir, 'ei'),
        readGrant: async () => {
          const granted = await auditAccess.authorize(svc.value, 'read');
          if (!granted.ok) throw granted.error;
          return granted.value;
        },
        principal: svc.value,
      },
    });
    deps.onConnectRuntime?.(runtime);
    connect = runtime.service;
  }
  registerRoutes(router, {
    workspaceStore,
    workspaceDataConfig,
    permissionManager,
    audit,
    auditSink,
    auditAccess,
    ...(procedureStepTimeoutMs !== undefined ? { procedureStepTimeoutMs } : {}),
    ...(deps.testBeforeStepExecute !== undefined ? { testBeforeStepExecute: deps.testBeforeStepExecute } : {}),
    ...(deps.externalTools !== undefined ? { externalTools: deps.externalTools } : {}),
    ...(connect !== undefined ? { connect } : {}),
    ...(deps.importFetch !== undefined ? { importFetch: deps.importFetch } : {}),
    ...(deps.chatProviderFactory !== undefined ? { chatProviderFactory: deps.chatProviderFactory } : {}),
  });
  if (sessionAuth !== undefined) registerAuthSessionRoutes(router, sessionAuth.service);
  if (passwordBundle !== undefined) {
    registerPasswordAuthRoutes(router, passwordBundle.service);
    if (sessionAuth === undefined && passwordSessions !== undefined) {
      // No Google sign-in, so no SessionAuthService: refresh and logout still need to exist for password sessions.
      registerSessionLifecycleRoutes(
        router,
        new SessionLifecycle({
          sessions: passwordSessions.sessions,
          bindings: passwordSessions.bindings,
          limiter: createRateLimiter({ windowMs: 60_000, max: 30 }),
          ...(gate !== undefined ? { gate } : {}),
        }),
      );
    }
  }
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
  const trustedProxyHops = parseTrustedProxyHops((deps.env ?? process.env)['XO_API_TRUSTED_PROXY_HOPS']); // throws on an invalid value

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

        const apiRequest = buildApiRequest(incoming, resolved.params, url, trustedProxyHops);
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
