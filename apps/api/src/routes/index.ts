import type { Router } from '../http/router.js';
import { json } from '../http/types.js';
import { registerRegistryRoutes } from './registry-routes.js';
import { registerPackageRoutes } from './package-routes.js';
import { registerRuntimeRoutes } from './runtime/runtime-routes.js';
import { registerCompilerRoutes } from './compiler/compiler-routes.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { registerSourceRoutes, type SourceRouteOptions } from './source-routes.js';
import { registerCompilationRoutes } from './source-compilation-routes.js';
import { registerExecutionRoutes } from './execution-routes.js';
import { registerHumanTaskRoutes } from './human-task-routes.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import { registerProcedureRoutes } from './procedure-routes.js';
import { registerWorkspaceAdminRoutes } from './workspace-admin-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { registerNotificationRoutes } from './notification-routes.js';
import { registerInboxRoutes } from './inbox-routes.js';
import { registerLibraryRoutes } from './library-routes.js';
import { registerChatRoutes, type ChatRouteOptions } from './chat-routes.js';
import { registerWorkflowDefinitionRoutes } from './workflow-definition-routes.js';
import { registerTestCaseRoutes } from './test-case-routes.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { openApiDocument } from '../openapi.js';
import type { PermissionManager } from '@xo/permissions';
import type { AuditAccessController, AuditSink } from '@xo/audit';
import type { AuditService } from '../audit/audit-service.js';
import { registerAuditRoutes } from './audit-routes.js';
import type { ExternalToolWiring } from '@xo/runtime';
import { describeInferenceReadiness } from '@xo/ai-core';
import { registerConnectRoutes } from './connect-routes.js';
import type { ConnectService } from '@xo/connect';

export interface RegisterRoutesDeps {
  readonly workspaceStore: WorkspaceStore;
  /** Where workspace-scoped package/registry storage lives — see `workspace/workspace-context.ts`. Not used by `registerWorkspaceRoutes` itself (workspace *metadata* uses its own, separate store — see `config.ts`'s `workspacesDir` vs `workspaceDataDir`). */
  readonly workspaceDataConfig: WorkspaceDataConfig;
  /** P1.0 M2 — required: routes cannot be registered without an authorization policy decision point. */
  readonly permissionManager: PermissionManager;
  /** P1.0 M4 — required: protected reads and lifecycle transitions cannot be registered without an audit service. */
  readonly audit: AuditService;
  /** The concrete sink; `GET /audit/events` and `POST /audit/purge` need its read/purge capability. */
  readonly auditSink: AuditSink;
  readonly auditAccess: AuditAccessController;
  /** P1.1 M3 closeout (D2): optional per-step procedure timeout (ms). Absent means no timeout. */
  readonly procedureStepTimeoutMs?: number;
  readonly testBeforeStepExecute?: () => Promise<void>;
  readonly externalTools?: ExternalToolWiring;
  /** Test seam / explicit injection for `GET /ready`. Defaults to `process.env`. */
  readonly inferenceEnv?: Readonly<Record<string, string | undefined>>;
  /** C7 — optional. When absent the `/connect/*` routes are not registered (404), never half-working. */
  readonly connect?: ConnectService;
  /** Injection seam for the URL importer (tests only) — see `SourceRouteOptions`. */
  readonly importFetch?: SourceRouteOptions['fetchDeps'];
  /** Injection seam for chat's model provider (tests / alternative deployments). */
  readonly chatProviderFactory?: ChatRouteOptions['providerFactory'];
}

export function registerRoutes(router: Router, deps: RegisterRoutesDeps): void {
  router.get('/health', async () => json(200, { status: 'ok' }));
  // Authenticated (NOT in auth's EXEMPT_PATHS). Liveness is `/health`; this reports inference *configuration* status only.
  // It never calls the provider (no billable inference from a probe) and never includes a credential.
  router.get('/ready', async () => json(200, { status: 'ok', inference: describeInferenceReadiness(deps.inferenceEnv ?? process.env) }));
  router.get('/openapi.json', async () => json(200, openApiDocument));

  registerRegistryRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerPackageRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerRuntimeRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerCompilerRoutes(router);
  registerWorkspaceRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerWorkspaceAdminRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerSettingsRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerNotificationRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerInboxRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerLibraryRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerWorkflowDefinitionRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerTestCaseRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerChatRoutes(
    router,
    deps.workspaceStore,
    deps.workspaceDataConfig,
    deps.chatProviderFactory !== undefined ? { providerFactory: deps.chatProviderFactory } : {},
  );
  registerSourceRoutes(
    router,
    deps.workspaceStore,
    deps.workspaceDataConfig,
    deps.audit,
    deps.importFetch !== undefined ? { fetchDeps: deps.importFetch } : {},
  );
  registerCompilationRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.audit);
  registerExecutionRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerHumanTaskRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerWorkflowRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerProcedureRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit, {
    ...(deps.procedureStepTimeoutMs !== undefined ? { stepTimeoutMs: deps.procedureStepTimeoutMs } : {}),
    ...(deps.testBeforeStepExecute !== undefined ? { testBeforeStepExecute: deps.testBeforeStepExecute } : {}),
    ...(deps.externalTools !== undefined ? { externalTools: deps.externalTools } : {}),
  });
  registerAuditRoutes(router, deps.audit, deps.auditSink, deps.auditAccess);
  if (deps.connect !== undefined) registerConnectRoutes(router, deps.connect);
}
