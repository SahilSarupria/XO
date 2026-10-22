import type { Router } from '../http/router.js';
import { json } from '../http/types.js';
import { registerRegistryRoutes } from './registry-routes.js';
import { registerPackageRoutes } from './package-routes.js';
import { registerRuntimeRoutes } from './runtime/runtime-routes.js';
import { registerCompilerRoutes } from './compiler/compiler-routes.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { registerSourceRoutes } from './source-routes.js';
import { registerCompilationRoutes } from './source-compilation-routes.js';
import { registerExecutionRoutes } from './execution-routes.js';
import { registerHumanTaskRoutes } from './human-task-routes.js';
import { registerWorkflowRoutes } from './workflow-routes.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { openApiDocument } from '../openapi.js';
import type { PermissionManager } from '@xo/permissions';
import type { AuditAccessController, AuditSink } from '@xo/audit';
import type { AuditService } from '../audit/audit-service.js';
import { registerAuditRoutes } from './audit-routes.js';
import { describeInferenceReadiness } from '@xo/ai-core';

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
  /** Test seam / explicit injection for `GET /ready`. Defaults to `process.env`. */
  readonly inferenceEnv?: Readonly<Record<string, string | undefined>>;
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
  registerWorkspaceRoutes(router, deps.workspaceStore);
  registerSourceRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.audit);
  registerCompilationRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.audit);
  registerExecutionRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerHumanTaskRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerWorkflowRoutes(router, deps.workspaceStore, deps.workspaceDataConfig, deps.permissionManager, deps.audit);
  registerAuditRoutes(router, deps.audit, deps.auditSink, deps.auditAccess);
}
