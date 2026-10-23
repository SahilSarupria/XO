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
import { registerWorkspaceAdminRoutes } from './workspace-admin-routes.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { registerNotificationRoutes } from './notification-routes.js';
import { registerInboxRoutes } from './inbox-routes.js';
import { registerLibraryRoutes } from './library-routes.js';
import { registerChatRoutes, type ChatRouteOptions } from './chat-routes.js';
import { registerWorkflowDefinitionRoutes } from './workflow-definition-routes.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import type { WorkspaceDataConfig } from '../workspace/workspace-context.js';
import { openApiDocument } from '../openapi.js';

export interface RegisterRoutesDeps {
  readonly workspaceStore: WorkspaceStore;
  /** Where workspace-scoped package/registry storage lives — see `workspace/workspace-context.ts`. Not used by `registerWorkspaceRoutes` itself (workspace *metadata* uses its own, separate store — see `config.ts`'s `workspacesDir` vs `workspaceDataDir`). */
  readonly workspaceDataConfig: WorkspaceDataConfig;
  /** Injection seam for the URL importer (tests only) — see `SourceRouteOptions`. */
  readonly importFetch?: SourceRouteOptions['fetchDeps'];
  /** Injection seam for chat's model provider (tests / alternative deployments). */
  readonly chatProviderFactory?: ChatRouteOptions['providerFactory'];
}

export function registerRoutes(router: Router, deps: RegisterRoutesDeps): void {
  router.get('/health', async () => json(200, { status: 'ok' }));
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
  registerWorkflowDefinitionRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
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
    deps.importFetch !== undefined ? { fetchDeps: deps.importFetch } : {},
  );
  registerCompilationRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerExecutionRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerHumanTaskRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
  registerWorkflowRoutes(router, deps.workspaceStore, deps.workspaceDataConfig);
}
