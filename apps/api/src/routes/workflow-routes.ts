import { ErrorCode, XoError } from '@xo/errors';
import type { Router } from '../http/router.js';
import type { ApiRequest, ApiResponse } from '../http/types.js';
import { json } from '../http/types.js';
import { errorToResponse } from '../http/error-mapping.js';
import type { PermissionManager } from '@xo/permissions';
import { requirePrincipal, type WorkspaceDataConfig } from '../workspace/workspace-context.js';
import type { WorkspaceRecord } from '../workspace/workspace.js';
import type { WorkspaceStore } from '../workspace/workspace.js';
import { toRecordedAuthentication } from '../auth/recorded-authentication.js';
import { loadWorkflowViews, makeRunnerContext } from '../workflows/workflow-views.js';
import { getWorkflowExecution, listWorkflowExecutions, toWorkflowExecutionView } from '../workflows/workflow-read.js';
import { auditedRead, type AuditService } from '../audit/audit-service.js';
import { registerRemovedStub } from './removed-stub.js';

/**
 * Workflow routes. The catalog (`GET /workflows`) and the historic composed executions (`GET /workflow-executions…`) stay readable.
 * UW-12b (ADR 0052): the composed-workflow runner was removed, so starting and resuming a composed execution answer
 * `410 XO_COMPOSED_RUNNER_REMOVED` naming the Workflow entity route that replaces them.
 */

function guarded(handler: (req: ApiRequest) => Promise<ApiResponse>): (req: ApiRequest) => Promise<ApiResponse> {
  return async (req) => {
    try {
      return await handler(req);
    } catch (cause) {
      return errorToResponse(cause);
    }
  };
}

/**
 * ADR 0035, now complete (ADR 0052): a start that is not a certified workflow has nowhere to run. Used by the controls routes to
 * refuse a trigger that names no readiness certificate.
 */
export function composedRunnerRetired(workspaceId: string): XoError {
  return new XoError(
    ErrorCode.WORKFLOW_REQUIRES_IR_RUNTIME,
    `workflows run only on the workflow runtime: generate the workflow (POST /workspaces/${workspaceId}/compilations/{compilationId}/generated-workflows), request its certificate, and start it with POST /workspaces/${workspaceId}/generated-workflows/{definitionId}/runs`,
    { context: { reason: 'composed_runner_retired' } },
  );
}

export function registerWorkflowRoutes(
  router: Router,
  workspaceStore: WorkspaceStore,
  dataConfig: WorkspaceDataConfig,
  permissionManager: PermissionManager,
  audit: AuditService,
): void {
  const auditCtx = { audit, workspaceStore };

  function runnerContext(workspace: WorkspaceRecord, req: ApiRequest) {
    return makeRunnerContext(workspace, requirePrincipal(req), dataConfig, permissionManager, toRecordedAuthentication(req.authentication));
  }

  // GET /workspaces/:workspaceId/workflows[?compilationId=]
  async function listWorkflows(req: ApiRequest): Promise<ApiResponse> {
    return auditedRead(req, auditCtx, { action: 'list.workflows', kind: 'workflow' }, async (workspace) => {
      const ctx = runnerContext(workspace, req);
      const only = req.query.get('compilationId');
      const { workflows, unavailable } = await loadWorkflowViews(ctx, only ?? undefined);
      return json(200, { workflows, ...(unavailable.length > 0 ? { unavailableCompilations: unavailable } : {}) });
    });
  }

  async function listExecutions(req: ApiRequest): Promise<ApiResponse> {
    return auditedRead(req, auditCtx, { action: 'list.workflow-executions', kind: 'workflow-execution' }, async (workspace) => {
      const ctx = runnerContext(workspace, req);
      const records = await listWorkflowExecutions(ctx);
      return json(200, { workflowExecutions: await Promise.all(records.map((r) => toWorkflowExecutionView(ctx, r))) });
    });
  }

  async function getExecution(req: ApiRequest): Promise<ApiResponse> {
    const id = req.params['workflowExecutionId'];
    if (id === undefined) throw new XoError(ErrorCode.INVALID_ARGUMENT, 'missing workflow execution id');
    return auditedRead(
      req,
      auditCtx,
      { action: 'get.workflow-execution', kind: 'workflow-execution', idParam: 'workflowExecutionId' },
      async (workspace) => {
        const ctx = runnerContext(workspace, req);
        return json(200, await toWorkflowExecutionView(ctx, await getWorkflowExecution(ctx, id)));
      },
    );
  }

  router.get('/workspaces/:workspaceId/workflows', guarded(listWorkflows));
  router.get('/workspaces/:workspaceId/workflow-executions', guarded(listExecutions));
  router.get('/workspaces/:workspaceId/workflow-executions/:workflowExecutionId', guarded(getExecution));
  registerRemovedStub(
    router,
    'post',
    '/workspaces/:workspaceId/workflows/:workflowId/executions',
    'POST /workspaces/{workspaceId}/workflow-entities/{workflowId}/runs (create the workflow with POST /workspaces/{workspaceId}/workflow-entities)',
    { workspaceStore, dataConfig, permission: 'author', action: 'start a composed workflow (removed)' },
  );
  registerRemovedStub(
    router,
    'post',
    '/workspaces/:workspaceId/workflow-executions/:workflowExecutionId/resume',
    'the Workflow entity run routes (a run on the workflow runtime resumes by itself; its approvals are decided with POST /workspaces/{workspaceId}/workflow-entities/{workflowId}/runs/{runId}/approvals/{approvalId})',
    { workspaceStore, dataConfig, permission: 'author', action: 'resume a composed workflow (removed)' },
  );
}
